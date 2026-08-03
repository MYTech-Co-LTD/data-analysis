// web/lib/scheduler.ts
// 定时采集调度器，使用 node-cron 注册任务
// 在首次调用时自动初始化

import cron, { ScheduledTask } from 'node-cron';
import { createClient } from '@insforge/sdk';
import { collectOnce, countRetailApi, decodeCompanyId, getYesterdayChina, getTodayChina, getDateOffsetChina, CollectResult } from './collect';
import { collectDeliveryOnce, countDeliveryApi, type DeliveryCollectResult } from './collect-delivery';
import { collectWholesaleOnce, countWholesaleApi, type WholesaleCollectResult } from './collect-wholesale';
import { collectItems, CollectItemsResult } from './collect-items';
import { collectBranches } from './collect-branches';
import { notifyWecom } from './notify';
import { runServiceDownBucket, runCollectTokenBucket, runHourlyBucket, runDailyBucket } from './monitor/runtime';
import { runQaChecks } from './qa-runner';
import detailSources from '../../services/semantic-generator/src/detail-sources.json';
import { duckQuery } from './qa/duck';
import { buildDayGlob } from './qa/d1';
import type { DetailSource } from './qa/types';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const DUCKDB_URL = process.env.DUCKDB_URL || "http://duckdb:9000";
const AGENT_API_KEY = process.env.AGENT_API_KEY!; // duckdb-service 鉴权（/compute /carry-dims 校验此 key，非 INSFORGE_API_KEY）
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000"; // PostgREST 直连（gateway 不代理 /rpc，固化 RPC 直连）

// DuckDB 查 parquet 行数（scheduler 对账驱动用：count API total vs 库已采 count，对得上不 full、对不上 full 补采）
async function duckdbParquetCount(pathGlob: string): Promise<number> {
  try {
    const r = await fetch(`${DUCKDB_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY }, body: JSON.stringify({ sql: `SELECT count(*) AS c FROM read_parquet('s3://lemeng-datasource/${pathGlob}')` }) });
    const d = await r.json();
    return d.data?.[0]?.c || 0;
  } catch { return 0; }
}

// DuckDB 查 parquet SUM（对账用：parquet 源 SUM vs compute 表 SUM）
async function duckdbParquetSum(pathGlob: string, valueCol: string): Promise<number> {
  try {
    const r = await fetch(`${DUCKDB_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY }, body: JSON.stringify({ sql: `SELECT COALESCE(round(sum(CAST(${valueCol} AS DECIMAL(14,2))),2),0) AS s FROM read_parquet('s3://lemeng-datasource/${pathGlob}')` }) });
    const d = await r.json();
    return d.data?.[0]?.s || 0;
  } catch { return 0; }
}

// 调度器状态：用 globalThis 持有，跨 chunk 单例。
// Next.js 把 instrumentation.ts 与 route handler 打包进不同 chunk，各自有独立模块作用域，
// 模块级变量不共享 → 会出现「两个 scheduler 实例」导致同一 cron 双触发、防重入锁也跨实例失效。
// 统一挂到 globalThis（同进程同 V8 global）确保唯一实例。
type SchedulerState = {
  jobs: Map<string, ScheduledTask>;
  running: Set<string>;
  initialized: boolean;
};
const globalForScheduler = globalThis as unknown as { __schedulerState?: SchedulerState };
const state: SchedulerState = (globalForScheduler.__schedulerState ??= {
  jobs: new Map<string, ScheduledTask>(),
  running: new Set<string>(),
  initialized: false,
});

// 引用共享状态：Map / Set 按引用共享，方法调用直接作用于全局实例；
// initialized 为布尔值（按值），必须经 state.initialized 读写才能跨 chunk 同步。
const scheduledJobs = state.jobs;
const runningTasks = state.running;

// 对账重试最大次数
const MAX_VERIFY_RETRIES = 3;

// 新一天对账最近 N 天（不只前一日）：晚生成/晚审核的单据若在 N 天内落账，
// 会被后续某天的对账发现并触发 full 补采（修 lookback=1 只对前一天的盲区）。
const RECONCILE_DAYS = 3;
// 逐天比 API count vs 库已采 count（最近 N 天，不含今天）：任一天 lib<api 返回该天日期，全匹配返回 null
async function reconcileTrailingDays(
  N: number,
  apiCount: (date: string) => Promise<number>,
  libCount: (date: string) => Promise<number>,
): Promise<string | null> {
  for (let i = 1; i <= N; i++) {
    const d = getDateOffsetChina(-i);
    const api = await apiCount(d);
    if (api <= 0) continue; // 该天 API 无数据（节假日/未来日），跳过
    const lib = await libCount(d);
    if (lib !== api) return d; // 少了=漏采 OR 多了=stale/退货 → full 重采
  }
  return null;
}

/**
 * 初始化调度器：读取所有启用的任务，注册 cron（自动初始化）
 */
export async function ensureSchedulerInitialized(): Promise<boolean> {
  if (state.initialized) return true;

  console.log('[scheduler] 初始化定时采集调度器...');

  // 通讯录全量兜底（平台基础设施，独立于 collect_tasks；先注册，不依赖采集任务查询结果/是否为空）
  registerDailyReconcileJob();
  registerDailySourceReconcileJob();
  registerDailyQaJob();
  registerContactSyncJob();
  registerCarryDimsJob();
  registerDimCustomerJob();
  registerWeeklyReconcileJob();
  registerMonitorJobs();
  registerTargetCloseJob();

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    // 查询所有启用的采集任务
    const { data: tasks, error } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, function_slug, schedule_cron, params, enabled')
      .eq('enabled', true);

    if (error) {
      console.error('[scheduler] 查询任务失败:', error);
      return false;
    }

    if (!tasks || tasks.length === 0) {
      console.log('[scheduler] 无启用的采集任务');
      state.initialized = true;
      return true;
    }

    console.log(`[scheduler] 发现 ${tasks.length} 个启用的任务`);

    for (const task of tasks) {
      registerTask(task);
    }

    state.initialized = true;
    console.log('[scheduler] 调度器初始化完成');
    return true;
  } catch (err: any) {
    console.error('[scheduler] 初始化异常:', err.message);
    return false;
  }
}

/**
 * 注册单个任务的 cron
 */
function registerTask(task: {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  schedule_cron: string;
  params: any;
}) {
  // 如果已注册，先取消
  if (scheduledJobs.has(task.id)) {
    scheduledJobs.get(task.id)?.stop();
    scheduledJobs.delete(task.id);
  }

  // 校验 cron 表达式
  if (!task.schedule_cron || !cron.validate(task.schedule_cron)) {
    console.warn(`[scheduler] 任务 ${task.name} 的 cron 表达式无效: ${task.schedule_cron}`);
    return;
  }

  console.log(`[scheduler] 注册任务: ${task.name} (${task.schedule_cron})`);

  // 注册 cron 任务
  const job = cron.schedule(task.schedule_cron, async () => {
    console.log(`[scheduler] ⏰ 定时触发: ${task.name} (${task.id})`);
    await executeTask(task);
  }, {
    timezone: 'Asia/Shanghai'
  });

  scheduledJobs.set(task.id, job);
}

// C1: 采集 verified 后触发报表计算（service 身份，无 perms；算全量写 report_*，查询时裁剪）。
// daily/category 用采集日期；weekly 滚动 8 周（upsert 幂等）。失败记 compute_logs + 企微告警，不阻塞采集。
function subtractDays(ymd: string, days: number): string {
  const dt = new Date(ymd + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().split("T")[0];
}

async function triggerCompute(client: any, dates: string[], taskId: string) {
  // dates = ['YYYY-MM-DD','YYYY-MM-DD']（getTodayChina/getYesterdayChina 格式），直接传 /compute（内部转 compact）
  const reports = [
    { type: "daily_sales",    dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "daily_category", dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "weekly_trend",   dateFrom: subtractDays(dates[0], 56), dateTo: dates[1] },
    { type: "daily_delivery",  dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "daily_wholesale", dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "item_sales",          dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "item_outbound",       dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "wholesale_customer",  dateFrom: dates[0],                   dateTo: dates[1] },
  ];
  for (const r of reports) {
    const startedAt = new Date();
    let status = "failed", rowsWritten: number | null = null, durationMs: number | null = null, error: string | null = null;
    try {
      const resp = await fetch(`${DUCKDB_URL}/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
        body: JSON.stringify({ report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo }),
      });
      const data = await resp.json().catch(() => ({} as any));
      if (resp.ok && data.success) {
        status = "success"; rowsWritten = data.rows_written ?? 0; durationMs = data.duration_ms ?? 0;
      } else {
        error = data.error || `HTTP ${resp.status}`;
      }
    } catch (e: any) {
      error = e.message || String(e);
    }
    await client.database.from("compute_logs").insert([{
      report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo, status,
      rows_written: rowsWritten, duration_ms: durationMs, error,
      triggered_by: `collect:${taskId}`,
      started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
    }]);
    if (status === "failed") {
      await notifyWecom("⚠️ 报表计算失败", `**报表**: ${r.type}\n**范围**: ${r.dateFrom} ~ ${r.dateTo}\n**错误**: ${error}\n**触发**: collect:${taskId}`);
    } else {
      console.log(`[scheduler] /compute ${r.type} ${r.dateFrom}~${r.dateTo}: ${rowsWritten} rows`);
    }
  }
}

// L4 数据质量巡检执行器（Task 9）：DB(postgrest rpc+from) + duck(duckdb HTTP) 双适配器，
// 调 runQaChecks 跑 D1/D2/C2；失败推企微告警。trigger: 'cron' 每日 09:15 全量 / 'collect' 采集后按源 D1。
async function runDailyQa(trigger: 'cron' | 'collect', checks?: string[], dateFrom?: string, dateTo?: string, d1Globs?: Record<string, string>) {
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: async (fn: string, body: Record<string, unknown>) => {
      const r = await fetch(`${POSTGREST_URL}/rpc/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) return { error: json };
      return { data: json };
    },
    from: (t: string) => client.database.from(t),
  } as any;
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY!, sql);
  // 随机后缀防同毫秒 run_id 撞 qa_logs 的 UNIQUE 约束（采集后 hook 与每日 09:15 可能同毫秒）
  const runId = `${trigger}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const results = await runQaChecks({ runId, trigger, db, duck, checks, dateFrom, dateTo, d1Globs });
  const failed = results.filter((r) => r.status !== 'pass');
  if (failed.length) {
    await notifyWecom('⚠️ 每日数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 10).map((r) => `${r.check_type}:${r.check_name} ${r.status}`).join('\n')}`).catch(() => {});
  }
  console.log(`[scheduler] __qa_${trigger}: ${results.length} 检查, 失败 ${failed.length}`);
  return results;
}

/**
 * 执行单个采集任务（含对账重试）
 * 根据 params.task_type 判断采集类型：
 *   - 'items' → 商品档案采集
 *   - 其他/无 → 订单明细采集
 */
async function executeTask(task: {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  params: any;
}, opts?: { reconcile?: boolean }) {
  // 防重入：已在运行则跳过本次触发
  if (runningTasks.has(task.id)) {
    console.warn(`[scheduler] 任务 ${task.name} (${task.id}) 已在运行，跳过本次触发`);
    return;
  }
  runningTasks.add(task.id);
  const startedAt = new Date();
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    // 1. 获取凭证
    let credentials: Record<string, string> = {};
    if (task.source_id) {
      const { data: cred } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', task.source_id)
        .single();

      if (cred?.credential_data) {
        try { credentials = JSON.parse(cred.credential_data); } catch { /* ignore */ }
      }
    }

    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) {
      console.error(`[scheduler] 任务 ${task.name}: 无凭证`);
      await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, 'No token configured');
      return;
    }

    // 2. 根据任务类型选择采集逻辑
    const params = task.params || {};

    if (params.task_type === 'items') {
      // ===== 商品档案采集 =====
      console.log(`[scheduler] 商品档案采集: ${task.name}`);
      const branchId = params.branch_id || 28444;
      const pageSize = params.page_size || 200;

      const result = await collectItems(authToken, branchId, pageSize);

      const finishedAt = new Date();
      await client.database
        .from('collect_tasks')
        .update({ last_run_at: finishedAt.toISOString() })
        .eq('id', task.id);

      const finalStatus = result.error ? 'failed' : (result.verified ? 'success' : 'partial');
      await writeLog(
        client,
        task.id,
        startedAt,
        finishedAt,
        finalStatus,
        result.collected,
        result.error || undefined,
        { total: result.total, deduped: result.deduped, dbCount: result.dbCount, verified: result.verified }
      );

      console.log(`[scheduler] 商品档案采集完成: ${result.collected}/${result.total} 条, DB ${result.dbCount}, 校验 ${result.verified ? '✅' : '❌'}`);
      return;
    }

    if (params.task_type === 'branches') {
      // ===== 门店档案采集 =====
      console.log(`[scheduler] 门店档案采集: ${task.name}`);
      const companyId = Number(params.company_id);
      const pageSize = params.page_size || 200;
      if (!companyId) {
        await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, '缺 params.company_id');
        return;
      }
      const result = await collectBranches(authToken, companyId, pageSize);

      const finishedAt = new Date();
      await client.database
        .from('collect_tasks')
        .update({ last_run_at: finishedAt.toISOString() })
        .eq('id', task.id);

      const finalStatus = result.error ? 'failed' : (result.verified ? 'success' : 'partial');
      await writeLog(
        client, task.id, startedAt, finishedAt, finalStatus, result.collected,
        result.error || undefined, { total: result.total, dbCount: result.dbCount, verified: result.verified }
      );
      console.log(`[scheduler] 门店档案采集完成: ${result.collected}/${result.total}, DB ${result.dbCount}, 校验 ${result.verified ? '✅' : '❌'}`);
      return;
    }

    if (params.task_type === 'delivery') {
      // ===== 配送调出明细采集（仅 3120，配送中心99；64188 共用此数据）=====
      console.log(`[scheduler] 配送明细采集: ${task.name}`);
      const distributionBranch = Number(params.distribution_branch_num) || 99;
      const branchNumsStr = String(distributionBranch);
      const limit = params.page_size || 200;
      const today = getTodayChina();
      // 模式判定（同 retail：新一天/距上次全量≥55min/无水位线 → full；否则 incremental）
      const watermark = params.watermark || {};
      const watermarkLastCount: number = watermark.last_count || 0;
      // 对账驱动：新一天对账前一日；同一天每小时对账当天；其余纯增量
      const companyId = decodeCompanyId(authToken);
      let mode: 'full' | 'incremental';
      if (opts?.reconcile) {
        // 对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
        const mismatch = await reconcileTrailingDays(RECONCILE_DAYS,
          (d) => countDeliveryApi(authToken, distributionBranch, branchNumsStr, `${d} 00:00:00`, `${d} 23:59:59`),
          (d) => duckdbParquetCount(`lemeng/transfer_detail/${companyId}/${d.replace(/-/g, '')}/all.parquet`));
        mode = mismatch ? 'full' : 'incremental';
        console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${mismatch ? `不匹配@${mismatch}` : '全匹配'} → ${mode}`);
      } else {
        mode = 'incremental';
      }
      // dtFrom/dtTo 带时分秒；full 回溯N天补延迟单据，incremental 当天增量
      const lookback = params.lookback_days ?? RECONCILE_DAYS;
      const dates = params.date_mode === 'today'
        ? (mode === 'full' ? { from: `${getDateOffsetChina(-lookback)} 00:00:00`, to: `${today} 23:59:59` } : { from: `${today} 00:00:00`, to: `${today} 23:59:59` })
        : { from: `${getYesterdayChina()} 00:00:00`, to: `${getYesterdayChina()} 23:59:59` };
      console.log(`[scheduler] 任务 ${task.name}: dtFrom=${dates.from}, mode=${mode}`);

      let lastResult: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
      let verified = false;

      if (mode === 'incremental') {
        lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit, { mode: 'incremental', watermarkLastCount });
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }
        verified = true; // 增量不对账，交给每小时 full
      } else {
        for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
          console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);
          lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit, { mode: 'full' });
          if (lastResult.error.startsWith('Token expired')) {
            await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
            await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
            return;
          }
          if (lastResult.apiTotal === 0) { await writeLog(client, task.id, startedAt, new Date(), 'success', 0); return; }
          const missing = lastResult.apiTotal - lastResult.records.length;
          verified = lastResult.records.length >= lastResult.apiTotal;
          if (verified) { console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`); break; }
          if (attempt < MAX_VERIFY_RETRIES) {
            console.warn(`[scheduler] ⚠️ 对账失败: 缺 ${missing}，5s 后重试`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次失败: 缺 ${missing}`);
            await notifyWecom('❌ 配送明细采集不完整', `**任务**: ${task.name}\n**日期**: ${dates.from}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**缺**: ${missing}`);
            lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): 缺 ${missing}`;
          }
        }
      }

      // 更新水位线（同 retail：仅落盘成功才推进）
      const finishedAt = new Date();
      const nowMs = finishedAt.getTime();
      const persistOk = !lastResult.error;
      const newWatermark = {
        date: today,
        last_count: persistOk ? lastResult.newApiTotal : watermarkLastCount,
        last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
      };
      await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString(), params: { ...params, watermark: newWatermark } }).eq('id', task.id);

      // 不 triggerCompute（先只落明细，汇总后续）
      const finalStatus = lastResult.error ? 'partial' : 'success';
      await writeLog(client, task.id, startedAt, finishedAt, finalStatus, lastResult.records.length, lastResult.error || undefined,
        { mode, skipped: lastResult.skipped, storage_path: lastResult.storagePath, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } });
      console.log(`[scheduler] 配送明细 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);
      return;
    }

    if (params.task_type === 'wholesale') {
      // ===== 批发销售明细采集（仅 3120；落 Parquet）=====
      console.log(`[scheduler] 批发明细采集: ${task.name}`);
      const branchNumsStr = '99';
      const limit = params.page_size || 200;
      const today = getTodayChina();
      const watermark = params.watermark || {};
      const watermarkLastCount: number = watermark.last_count || 0;
      // 对账驱动：新一天对账前一日；同一天每小时对账当天；其余纯增量
      const companyId = decodeCompanyId(authToken);
      let mode: 'full' | 'incremental';
      if (opts?.reconcile) {
        // 对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
        const mismatch = await reconcileTrailingDays(RECONCILE_DAYS,
          (d) => countWholesaleApi(authToken, branchNumsStr, `${d} 00:00:00`, `${d} 23:59:59`),
          (d) => duckdbParquetCount(`lemeng/wholesale_detail/${companyId}/${d.replace(/-/g, '')}/all.parquet`));
        mode = mismatch ? 'full' : 'incremental';
        console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${mismatch ? `不匹配@${mismatch}` : '全匹配'} → ${mode}`);
      } else {
        mode = 'incremental';
      }
      const lookback = params.lookback_days ?? RECONCILE_DAYS;
      const dates = params.date_mode === 'today'
        ? (mode === 'full' ? { from: `${getDateOffsetChina(-lookback)} 00:00:00`, to: `${today} 23:59:59` } : { from: `${today} 00:00:00`, to: `${today} 23:59:59` })
        : { from: `${getYesterdayChina()} 00:00:00`, to: `${getYesterdayChina()} 23:59:59` };
      console.log(`[scheduler] 任务 ${task.name}: dateFrom=${dates.from}, mode=${mode}`);

      let lastResult: WholesaleCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
      let verified = false;
      if (mode === 'incremental') {
        lastResult = await collectWholesaleOnce(authToken, branchNumsStr, dates.from, dates.to, limit, { mode: 'incremental', watermarkLastCount });
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }
        verified = true;
      } else {
        for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
          console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);
          lastResult = await collectWholesaleOnce(authToken, branchNumsStr, dates.from, dates.to, limit, { mode: 'full' });
          if (lastResult.error.startsWith('Token expired')) {
            await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
            await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
            return;
          }
          if (lastResult.apiTotal === 0) { await writeLog(client, task.id, startedAt, new Date(), 'success', 0); return; }
          const missing = lastResult.apiTotal - lastResult.records.length;
          verified = lastResult.records.length >= lastResult.apiTotal;
          if (verified) { console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`); break; }
          if (attempt < MAX_VERIFY_RETRIES) {
            console.warn(`[scheduler] ⚠️ 对账失败: 缺 ${missing}，5s 后重试`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次失败: 缺 ${missing}`);
            await notifyWecom('❌ 批发明细采集不完整', `**任务**: ${task.name}\n**日期**: ${dates.from}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**缺**: ${missing}`);
            lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): 缺 ${missing}`;
          }
        }
      }
      const finishedAt = new Date();
      const nowMs = finishedAt.getTime();
      const persistOk = !lastResult.error;
      const newWatermark = {
        date: today,
        last_count: persistOk ? lastResult.newApiTotal : watermarkLastCount,
        last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
      };
      await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString(), params: { ...params, watermark: newWatermark } }).eq('id', task.id);
      const finalStatus = lastResult.error ? 'partial' : 'success';
      await writeLog(client, task.id, startedAt, finishedAt, finalStatus, lastResult.records.length, lastResult.error || undefined,
        { mode, skipped: lastResult.skipped, storage_path: lastResult.storagePath, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } });
      console.log(`[scheduler] 批发明细 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);
      return;
    }

    // ===== 订单明细采集（默认） =====
    const today = getTodayChina();
    const branchNums = params.branch_nums || [];
    const branchNumsStr = branchNums.join(',');
    const pageSize = params.page_size || 200;

    // 模式判定：新一天 / 距上次全量≥55min / 无水位线 → full（覆盖+核对）；否则 incremental（续采尾部）
    const watermark = params.watermark || {};
    const watermarkLastCount: number = watermark.last_count || 0;
    // 对账驱动：新一天对账前一日(通过 incremental / 失败 full)；同一天每小时对账当天；其余纯增量
    const companyId = decodeCompanyId(authToken);
    let mode: 'full' | 'incremental';
    if (opts?.reconcile) {
      // 新一天：对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
      const mismatch = await reconcileTrailingDays(RECONCILE_DAYS,
        (d) => countRetailApi(authToken, branchNums, branchNumsStr, [d, d]),
        (d) => duckdbParquetCount(`lemeng/retail_detail/${companyId}/${d}/all.parquet`));
      mode = mismatch ? 'full' : 'incremental';
      console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${mismatch ? `不匹配@${mismatch}` : '全匹配'} → ${mode}`);
    } else {
      mode = 'incremental'; // 当天纯增量（API 实时涨，当天对账永远库<API 不准；漏了次日对账前一日兜底补）
    }
    // dates：full 回溯N天(补延迟生成/审核的单据，按 bizday 分区去重)；incremental 当天增量(水位线续采尾部)
    const lookback = params.lookback_days ?? RECONCILE_DAYS;
    const dates = params.date_mode === 'today'
      ? (mode === 'full' ? [getDateOffsetChina(-lookback), today] : [today, today])
      : (params.dates || [getYesterdayChina(), getYesterdayChina()]);

    console.log(`[scheduler] 任务 ${task.name}: dates=${dates[0]}, branches=${branchNums.length}, mode=${mode}`);

    let lastResult: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
    let verified = false;

    if (mode === 'incremental') {
      // 增量：单次拉尾部，不重试（下一轮或每小时 full 会补全）
      lastResult = await collectOnce(authToken, branchNums, branchNumsStr, dates, pageSize, { mode: 'incremental', watermarkLastCount });

      if (lastResult.error.startsWith('Token expired')) {
        await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
        await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
        return;
      }
      verified = true; // 增量不做条数对账，交给每小时 full 核对
    } else {
      // 全量：保留对账重试循环
      for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
        console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);

        lastResult = await collectOnce(authToken, branchNums, branchNumsStr, dates, pageSize, { mode: 'full' });

        // Token 过期直接退出
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }

        // 无数据直接退出
        if (lastResult.apiTotal === 0) {
          await writeLog(client, task.id, startedAt, new Date(), 'success', 0);
          return;
        }

        // 对账
        const missing = lastResult.apiTotal - lastResult.records.length;
        verified = lastResult.records.length >= lastResult.apiTotal;

        if (verified) {
          console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`);
          break;
        }

        if (attempt < MAX_VERIFY_RETRIES) {
          console.warn(`[scheduler] ⚠️ 对账失败: 缺少 ${missing} 条，5 秒后重试...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次均失败: 缺少 ${missing} 条`);
          await notifyWecom(
            '❌ 定时采集不完整（已重试3次）',
            `**任务**: ${task.name}\n**日期**: ${dates[0]}\n**采集数**: ${lastResult.records.length}\n**API总数**: ${lastResult.apiTotal}\n**缺少**: ${missing} 条\n**建议**: 请检查网络或手动重新采集`
          );
          lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): 缺少 ${missing} 条`;
        }
      }
    }

    // 更新水位线：仅当本次落盘成功（无 error）才推进 last_count；失败保持旧水位线，下次多重叠
    const finishedAt = new Date();
    const nowMs = finishedAt.getTime();
    const persistOk = !lastResult.error;
    const newWatermark = {
      date: today,
      last_count: persistOk ? lastResult.newApiTotal : watermarkLastCount,
      last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
    };
    await client.database
      .from('collect_tasks')
      .update({
        last_run_at: finishedAt.toISOString(),
        params: { ...params, watermark: newWatermark },
      })
      .eq('id', task.id);

    // C1: 采集后算报表（success/partial 都触发；service 身份；compute 读已落 parquet 幂等，下次覆盖。spec success/partial）
    if (dates && dates.length === 2) {
      await triggerCompute(client, dates, task.id);
    }

    // L4 采集后即时 D1 去重守护（当日增量后查唯一性，轻量）；QA 失败不阻塞采集流程
    try {
      const src = (detailSources as DetailSource[]).find((s) => s.function_slug === task.function_slug);
      if (src) {
        const todayCompact = getDateOffsetChina(0).replace(/-/g, '');
        // D1 只扫当日分区（buildDayGlob 按源目录格式把日期段替换成具体日），避免每 5 分钟全库重扫
        const dayGlob = buildDayGlob(src, todayCompact);
        await runDailyQa('collect', [`D1:${src.name}`, `D2:${src.name}`], todayCompact, todayCompact, { [src.name]: dayGlob });
      }
    } catch (e: any) { console.error('[scheduler] 采集后 QA 失败:', e?.message ?? e); }

    const finalStatus = lastResult.error ? 'partial' : 'success';
    await writeLog(
      client,
      task.id,
      startedAt,
      finishedAt,
      finalStatus,
      lastResult.records.length,
      lastResult.error || undefined,
      {
        mode,
        skipped: lastResult.skipped,
        storage_path: lastResult.storagePath,
        verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified }
      }
    );

    console.log(`[scheduler] 任务 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);

  } catch (error: any) {
    console.error(`[scheduler] 任务 ${task.name} 异常:`, error.message);
    await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, error.message);
    await notifyWecom('❌ 定时采集异常', `**任务**: ${task.name}\n**错误**: ${error.message}`);
  } finally {
    runningTasks.delete(task.id);
  }
}

/**
 * 写入采集日志
 */
async function writeLog(
  client: any,
  taskId: string,
  startedAt: Date,
  finishedAt: Date,
  status: string,
  rowsCollected: number,
  errorMessage?: string,
  responseSummary?: any
) {
  await client.database
    .from('collect_logs')
    .insert([{
      task_id: taskId,
      status: status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rows_collected: rowsCollected,
      error_message: errorMessage || null,
      response_summary: responseSummary || null,
    }]);
}

/**
 * 重新加载调度器（任务配置变更后调用）
 */
export async function reloadScheduler() {
  console.log('[scheduler] 重新加载调度器...');

  // 停止所有任务
  for (const [id, job] of scheduledJobs) {
    job.stop();
    console.log(`[scheduler] 停止任务: ${id}`);
  }
  scheduledJobs.clear();

  // 重置初始化标记，重新初始化
  state.initialized = false;
  await ensureSchedulerInitialized();
}

/**
 * 注册通讯录全量兜底同步（平台基础设施，独立于 collect_tasks）。
 * 每日 03:17 调 functions/wecom-sync-contacts 全量自愈（架构 §7.1.2）。
 */
function registerContactSyncJob() {
  const JOB_KEY = '__contact_sync';
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate('17 3 * * *')) return;
  const job = cron.schedule('17 3 * * *', async () => {
    if (runningTasks.has(JOB_KEY)) {
      console.warn('[scheduler] 通讯录同步已在运行，跳过本次触发');
      return;
    }
    runningTasks.add(JOB_KEY);
    try {
      console.log('[scheduler] ⏰ 通讯录全量兜底同步触发');
      const resp = await fetch(`${INSFORGE_API_BASE}/functions/wecom-sync-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INSFORGE_API_KEY}` },
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[scheduler] 通讯录同步结果:', resp.status, data);
    } catch (e: any) {
      console.error('[scheduler] 通讯录同步异常:', e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set(JOB_KEY, job);
  console.log('[scheduler] 注册通讯录兜底同步 (17 3 * * *, Asia/Shanghai)');
}

/**
 * 注册监控扫描桶（架构 §8.1）。4 个节奏：
 *   每分钟 service_down；每5分钟 collect_fail/request_fail/token_expire；
 *   每小时 data_freshness/contact_sync；每日 data_integrity。
 * Phase A 仅前两桶有 evaluator，后两桶空跑（loadRules 空），Phase B 填。
 */
// C3: 维表 carry 定时兜底（每天 04:33，避开通讯录 03:17；对齐 registerContactSyncJob 模式）
function registerCarryDimsJob() {
  const JOB_KEY = "__carry_dims";
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate("33 4 * * *")) return;
  const job = cron.schedule("33 4 * * *", async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 维表 carry 定时兜底触发");
      const resp = await fetch(`${DUCKDB_URL}/carry-dims`, {
        method: "POST", headers: { "x-agent-key": AGENT_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log("[scheduler] carry-dims 结果:", resp.status, data);
    } catch (e: any) {
      console.error("[scheduler] carry-dims 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册维表 carry 兜底 (33 4 * * *, Asia/Shanghai)");
}

// A4: dim_customer 派生定时（每天 04:20，carry-dims 04:33 前→carry 自动 COPY 当日新客户）
function registerDimCustomerJob() {
  const JOB_KEY = "__dim_customer";
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate("20 4 * * *")) return;
  const job = cron.schedule("20 4 * * *", async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ dim_customer 派生定时触发");
      const resp = await fetch(`${DUCKDB_URL}/derive-dim-customer`, {
        method: "POST", headers: { "x-agent-key": AGENT_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log("[scheduler] derive-dim-customer 结果:", resp.status, data);
    } catch (e: any) {
      console.error("[scheduler] derive-dim-customer 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册 dim_customer 派生 (20 4 * * *, Asia/Shanghai)");
}

// D: 目标固化定时兜底（每天 05:10，C1 daily compute 之后；end_date<today 的 active 目标自动固化）
// 每周一对账（最近7天 API total vs 库 parquet count，异常/通过都推企微）
/**
 * 每日 02:00 明细采集对账（retail/delivery/wholesale，3天窗口 full 补晚落账单）。
 * 与常规 8-23 增量采集解耦：2点此 job 传 reconcile=true → isNewDay 式对账最近3天+full 补采；
 * 8点起常规 cron 调 executeTask(task)（无 reconcile）→ 只当天增量，不对账。
 */
function registerDailyReconcileJob() {
  const JOB_KEY = "__daily_reconcile";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "0 2 * * *";
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 每日02:00 明细对账触发（3天窗口）");
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const { data: tasks, error } = await client.database.from("collect_tasks")
        .select("id, name, source_id, function_slug, schedule_cron, params")
        .eq("enabled", true)
        .eq("function_slug", "collect-lemeng");
      if (error) throw new Error(`查询采集任务失败: ${error.message}`);
      for (const task of (tasks ?? [])) {
        try { await executeTask(task, { reconcile: true }); }
        catch (e: any) { console.error(`[scheduler] 02:00对账 ${task.name} 异常:`, e?.message ?? e); }
      }
      console.log("[scheduler] 每日02:00 明细对账完成");
    } catch (e: any) {
      console.error("[scheduler] 每日对账异常:", e?.message ?? e);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册每日02:00明细对账 (0 2 * * *, Asia/Shanghai)");
}

/**
 * 每日源对账（09:07）：pipeline 表 SUM vs DuckDB parquet SUM，差>1元告警。
 * 确保 compute 表与 parquet 源精确一致，任何计算/去重 bug 都能自动发现。
 */
function registerDailySourceReconcileJob() {
  const JOB_KEY = "__daily_source_reconcile";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "7 9 * * *";
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      const yesterday = getDateOffsetChina(-1);
      const compactDate = yesterday.replace(/-/g, '');
      const companyId = '3120';
      console.log(`[scheduler] ⏰ 每日源对账: ${yesterday}`);
      // [metric, parquetPath, valueCol]
      const checks = [
        { metric: 'sales', path: `lemeng/retail_detail/${companyId}/${yesterday}/all.parquet`, col: 'sale_money' },
        { metric: 'delivery', path: `lemeng/transfer_detail/${companyId}/${compactDate}/all.parquet`, col: 'out_money' },
        { metric: 'wholesale', path: `lemeng/wholesale_detail/${companyId}/${compactDate}/all.parquet`, col: 'wholesale_money' },
      ];
      // 表 SUM（RPC 一次拿全）
      const rpcRes = await fetch(`${POSTGREST_URL}/rpc/reconcile_table_consistency`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` },
        body: JSON.stringify({ p_date: yesterday }),
      });
      const tableData = await rpcRes.json();
      const tableSums = new Map<string, number>((tableData || []).map((r: any) => [r.metric, Number(r.table_sum) || 0]));
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const alerts: string[] = [];
      for (const c of checks) {
        const parquetSum = await duckdbParquetSum(c.path, c.col);
        const tableSum = tableSums.get(c.metric) || 0;
        const diff = Math.round((parquetSum - tableSum) * 100) / 100;
        const ok = Math.abs(diff) <= 1;
        await client.database.from('reconcile_daily_results').insert([{ check_date: yesterday, metric: c.metric, table_sum: tableSum, parquet_sum: parquetSum, diff, status: ok ? 'ok' : 'mismatch' }]);
        if (!ok) alerts.push(`${c.metric}: 表 ${tableSum} / parquet ${parquetSum} / 差 ${diff}`);
        console.log(`[scheduler] 对账 ${c.metric}: 表=${tableSum} parquet=${parquetSum} 差=${diff} ${ok ? '✅' : '❌'}`);
      }
      if (alerts.length) await notifyWecom('⚠️ 每日源对账异常', `**日期**: ${yesterday}\n${alerts.join('\n')}`);
      else console.log(`[scheduler] ✅ 每日源对账全通过: ${yesterday}`);
    } catch (e: any) { console.error('[scheduler] 每日源对账异常:', e?.message ?? e); }
    finally { runningTasks.delete(JOB_KEY); }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set(JOB_KEY, job);
  console.log('[scheduler] 注册每日源对账 (7 9 * * *, Asia/Shanghai)');
}

/**
 * 每日数据质量巡检（09:15）：全量跑 D1/D2/C2，错开 09:07 源对账。
 * L4 spec：每日全量 QA 定时（Task 9）。
 */
function registerDailyQaJob() {
  const JOB_KEY = "__qa_full";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "15 9 * * *";   // 09:15，错开 09:07 源对账
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try { await runDailyQa('cron'); }
    catch (e: any) { console.error('[scheduler] __qa_full 异常:', e?.message ?? e); }
    finally { runningTasks.delete(JOB_KEY); }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set(JOB_KEY, job);
  console.log('[scheduler] 注册每日数据质量巡检 (15 9 * * *, Asia/Shanghai)');
}

function registerWeeklyReconcileJob() {
  const JOB_KEY = "__weekly_reconcile";
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate("7 8 * * 1")) return;
  const job = cron.schedule("7 8 * * 1", async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 每周采集对账触发(最近7天)");
      const days = Array.from({ length: 7 }, (_, i) => getDateOffsetChina(-7 + i));
      const resp = await fetch("http://localhost:3000/api/admin/reconcile-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
      const d = await resp.json();
      console.log("[scheduler] 周对账完成: 异常", d.abnormal_count, "/", d.total, "(企微已推)");
    } catch (e: any) { console.error("[scheduler] 周对账失败:", e.message); }
    finally { runningTasks.delete(JOB_KEY); }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册每周采集对账 (7 8 * * 1, Asia/Shanghai)");
}

function registerTargetCloseJob() {
  const JOB_KEY = "__target_close";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "10 5 * * *";
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 目标固化定时触发（end_date<today 的 active 目标）");
      const dueRes = await fetch(`${POSTGREST_URL}/rpc/get_due_targets`, {
        method: "POST",
        headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const due: { id: number }[] = await dueRes.json().catch(() => []);
      for (const t of due) {
        const cr = await fetch(`${POSTGREST_URL}/rpc/close_target`, {
          method: "POST",
          headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_target_id: t.id }),
        });
        const data = await cr.json().catch(() => ({}));
        console.log(`[scheduler] close_target(${t.id}):`, (data as any)?.ok, JSON.stringify(data));
      }
    } catch (e: any) {
      console.error("[scheduler] target_close 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册目标固化兜底 (10 5 * * *, Asia/Shanghai)");
}

function registerMonitorJobs() {
  const specs: Array<[string, string, () => Promise<void>]> = [
    ['__monitor_service', '* * * * *', runServiceDownBucket],
    ['__monitor_collect_token', '*/5 * * * *', runCollectTokenBucket],
    ['__monitor_hourly', '0 * * * *', runHourlyBucket],
    ['__monitor_daily', '0 3 * * *', runDailyBucket],
  ];
  for (const [key, expr, fn] of specs) {
    if (scheduledJobs.has(key)) continue;
    if (!cron.validate(expr)) continue;
    const job = cron.schedule(expr, async () => {
      if (runningTasks.has(key)) return;
      runningTasks.add(key);
      try { await fn(); } finally { runningTasks.delete(key); }
    }, { timezone: 'Asia/Shanghai' });
    scheduledJobs.set(key, job);
    console.log(`[scheduler] 注册监控桶 ${key} (${expr})`);
  }
}

/**
 * 获取已注册的任务列表
 */
export function getScheduledTasks() {
  return Array.from(scheduledJobs.entries()).map(([id, job]) => ({
    task_id: id,
    running: job.getStatus() === 'scheduled'
  }));
}