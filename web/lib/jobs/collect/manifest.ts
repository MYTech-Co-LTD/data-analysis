/* eslint-disable @typescript-eslint/no-explicit-any -- P1 纯搬移：job 函数体从 scheduler.ts 原样搬入（不改进），保留既有 any 用法；P1 冻结后再逐步收紧 */
// web/lib/jobs/collect/manifest.ts
// 采集 job（动态）：collect_tasks 每行一个 manifest（id=task.id, schedule=task.schedule_cron, run=executeTask）。
// executeTask 从 scheduler.ts 原样搬入（不改进）；唯一组织变化：数据源拉取经 collectors registry 分发
// （COLLECTORS['lemeng'].collectOnce/count，原始结果仍从 detail 读取，后续对账/水位线/告警逻辑逐字不变）。
// P1：cron 注册由薄 scheduler 按 manifest.schedule 完成；锁/水位线机制随 job 搬迁（runningTasks + tryAcquireLock + params.watermark）。
import { createClient } from '@insforge/sdk';
import type { JobManifest, JobResult } from '../../contracts';
import { decodeCompanyId, fetchWithTimeout, getDateOffsetChina, getTodayChina, getYesterdayChina, REQUEST_TIMEOUT } from '../../collect';
import type { CollectResult } from '../../collect';
import type { CollectBranchesResult } from '../../collect-branches';
import type { DeliveryCollectResult } from '../../collect-delivery';
import type { CollectItemsResult } from '../../collect-items';
import type { WholesaleCollectResult } from '../../collect-wholesale';
import { COLLECTORS } from '../../collectors/registry';
import { notifyWecom } from '../../notify';
import { runPostCollectQa } from '../qa/manifest';
import { tryAcquireLock } from '../../scheduler-lock';
import { AGENT_API_KEY, DUCKDB_URL, INSFORGE_API_BASE, INSFORGE_API_KEY } from '../env';
import { runningTasks } from '../state';

/** 乐檬采集器（registry 分发入口；P2 已冻结，后续新增数据源 = registry 追加行，collect job 不改） */
const lemeng = COLLECTORS['lemeng'];

export type CollectTask = {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  schedule_cron: string;
  params: any;
};

// DuckDB 查 parquet 行数（对账驱动用：count API total vs 库已采 count，对得上不 full、对不上 full 补采）
// 30s 超时（fetchWithTimeout）：executeTask 对账路径挂起 → 返 0 → 触发 full 重采，不永久持锁。
async function duckdbParquetCount(pathGlob: string): Promise<number> {
  try {
    const r = await fetchWithTimeout(`${DUCKDB_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY }, body: JSON.stringify({ sql: `SELECT count(*) AS c FROM read_parquet('s3://lemeng-datasource/${pathGlob}')` }) }, REQUEST_TIMEOUT);
    const d = await r.json();
    return d.data?.[0]?.c || 0;
  } catch { return 0; }
}

// 对账重试最大次数
const MAX_VERIFY_RETRIES = 3;

// 新一天对账最近 N 天（不只前一日）：晚生成/晚审核的单据若在 N 天内落账，
// 会被后续某天的对账发现并触发 full 补采（修 lookback=1 只对前一天的盲区）。
const RECONCILE_DAYS = 3;
// 逐天比 API count vs 库已采 count（最近 N 天，不含今天）：
//   mismatch  → lib !== api（漏采/stale）→ full 重采
//   delayed   → api=0 但库有数据（源数据延迟生成，如配送按审核时间晚落账）→ 不 full（API 还 0 时
//               full 覆盖会清空更糟），记 delayed 告警；后续对账（12:00/19:00/次日02:00）API 恢复
//               后走 mismatch → 自动 full 补采。修复 2026-08-26 配送数据延迟被 `api<=0 continue` 静默跳过盲区。
//   真无数据（api=0 且库 0，如节假日）→ 跳过
export async function reconcileTrailingDays(
  N: number,
  apiCount: (date: string) => Promise<number>,
  libCount: (date: string) => Promise<number>,
): Promise<{ mismatch?: string; delayed?: string[] }> {
  const delayed: string[] = [];
  for (let i = 1; i <= N; i++) {
    const d = getDateOffsetChina(-i);
    const api = await apiCount(d);
    if (api <= 0) {
      const lib = await libCount(d);
      if (lib > 0) {
        delayed.push(d);
        console.warn(`[scheduler] ${d} API count=0 但库 ${lib} 行（数据延迟/异常，待 API 恢复补采）`);
      }
      continue; // 真无数据（节假日/未来日）→ 跳过
    }
    const lib = await libCount(d);
    if (lib !== api) return { mismatch: d }; // 少了=漏采 OR 多了=stale/退货 → full 重采
  }
  return delayed.length ? { delayed } : {};
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
      const resp = await fetchWithTimeout(`${DUCKDB_URL}/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
        body: JSON.stringify({ report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo }),
      }, REQUEST_TIMEOUT);
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

/**
 * 水位线日界重置：watermark.last_count 是单任务跨日计数器（date 字段存当天日期但从未被检查），
 * 前一天的高水位（如 64188 的 5880）会挡住第二天低于它的当天增量——incremental 的
 * `apiTotal <= watermark` 整天 skip，漏采当天数据（2026-08-07 品品甜当天 0 行即此 bug）。
 * 修复：watermark.date !== 当天 → last_count 归 0（新一天重新起算）；同天用 Number() 强转，
 * 避免 lemeng 返回的字符串总数（如 "5163"）与字符串水位线做字典序比较导致误判。
 */
function watermarkLastCountFor(params: any, today: string): number {
  const wm = params.watermark || {};
  if (wm.date !== today) return 0;
  return Number(wm.last_count) || 0;
}

/**
 * 执行单个采集任务（含对账重试）
 * 根据 params.task_type 判断采集类型：
 *   - 'items' → 商品档案采集
 *   - 其他/无 → 订单明细采集
 */
export async function executeTask(task: CollectTask, opts?: { reconcile?: boolean }) {
  // 防重入：已在运行则跳过本次触发；陈旧锁（>30min，任务挂起/finally 未执行残留）自动释放——
  // 只清锁跳本次、不做并发重入（避免旧 promise 仍存活时双跑），等下次 cron 自然恢复
  if (!tryAcquireLock(runningTasks, task.id, `任务 ${task.name} (${task.id})`, { logSkip: true })) {
    return;
  }
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

    // 2. 每次从 DB 重读任务 params（闭包快照的 task.params 会陈旧——cron 注册时快照的水位线
    //    写回 DB 后永远不会被读到，导致水位线冻结在高位、当天增量整天 skip。必须重读最新 params）。
    let params = task.params || {};
    try {
      const { data: fresh } = await client.database
        .from('collect_tasks')
        .select('params')
        .eq('id', task.id)
        .single();
      if (fresh?.params) params = fresh.params;
    } catch (e: any) {
      console.error(`[scheduler] 任务 ${task.name}: 重读 params 失败，用传入快照`, e?.message ?? e);
    }

    // 3. 根据任务类型选择采集逻辑

    if (params.task_type === 'items') {
      // ===== 商品档案采集 =====
      console.log(`[scheduler] 商品档案采集: ${task.name}`);
      const branchId = params.branch_id || 28444;
      const pageSize = params.page_size || 200;

      const cr = await lemeng.collectOnce({ authToken, task: 'items', branchId }, { pageSize });
      const result = cr.detail as CollectItemsResult;

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

      // 商品采集成功后立即 carry-dims 同步 parquet（/compute 用 dim_item.parquet 不用 PG），
      // 否则新商品要等次日 04:33 carry-dims 才进 parquet——当天配送/出库映射不到归"其他"（实测坑 2026-08-08）
      if (!result.error) {
        try {
          const cr2 = await fetch(`${DUCKDB_URL}/carry-dims`, {
            method: 'POST', headers: { 'x-agent-key': AGENT_API_KEY },
          });
          const cd = await cr2.json().catch(() => ({}));
          console.log(`[scheduler] 商品采集后 carry-dims: ${cr2.status} dim_item=${(cd as any)?.results?.find((r: any) => r.name === 'dim_item')?.records ?? '?'}`);
        } catch (e: any) { console.error('[scheduler] 商品采集后 carry-dims 失败:', e?.message ?? e); }
      }
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
      const cr = await lemeng.collectOnce({ authToken, task: 'branches', companyId }, { pageSize });
      const result = cr.detail as CollectBranchesResult;

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
      // 门店采集成功后立即 carry-dims 同步 dim_branch parquet（同商品档案原理）
      if (!result.error) {
        try {
          const cr2 = await fetch(`${DUCKDB_URL}/carry-dims`, { method: 'POST', headers: { 'x-agent-key': AGENT_API_KEY } });
          console.log(`[scheduler] 门店采集后 carry-dims: ${cr2.status}`);
        } catch (e: any) { console.error('[scheduler] 门店采集后 carry-dims 失败:', e?.message ?? e); }
      }
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
      const watermarkLastCount: number = watermarkLastCountFor(params, today);
      // 对账驱动：新一天对账前一日；同一天每小时对账当天；其余纯增量
      const companyId = decodeCompanyId(authToken);
      let mode: 'full' | 'incremental';
      if (opts?.reconcile) {
        // 对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
        const rc = await reconcileTrailingDays(RECONCILE_DAYS,
          (d) => lemeng.count!({ authToken, task: 'delivery', distributionBranch, branchNumsStr }, [d, d]),
          (d) => duckdbParquetCount(`lemeng/transfer_detail/${companyId}/${d.replace(/-/g, '')}/all.parquet`));
        if (rc.delayed?.length) {
          await notifyWecom('⚠️ 配送数据疑似延迟', `${task.name} ${rc.delayed.join(',')} API=0 但库有数据，后续对账 API 恢复后自动补采`).catch(() => {});
        }
        mode = rc.mismatch ? 'full' : 'incremental';
        console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${rc.mismatch ? `不匹配@${rc.mismatch}` : (rc.delayed?.length ? `延迟@${rc.delayed.join(',')}` : '全匹配')} → ${mode}`);
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
        const cr = await lemeng.collectOnce({ authToken, task: 'delivery', distributionBranch, branchNumsStr }, { mode: 'incremental', watermarkLastCount, dates: [dates.from, dates.to], limit });
        lastResult = cr.detail as DeliveryCollectResult;
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }
        verified = !lastResult.error; // 铁律③：增量虽不做条数对账，merge 写入失败 → verified=false
      } else {
        for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
          console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);
          const cr = await lemeng.collectOnce({ authToken, task: 'delivery', distributionBranch, branchNumsStr }, { mode: 'full', dates: [dates.from, dates.to], limit });
          lastResult = cr.detail as DeliveryCollectResult;
          if (lastResult.error.startsWith('Token expired')) {
            await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
            await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
            return;
          }
          if (lastResult.apiTotal === 0) { await writeLog(client, task.id, startedAt, new Date(), 'success', 0); return; }
          // 铁律③：条数达标 AND 落盘无错 才算 verified；transform/merge 失败 → verified=false 触发重试/告警
          const missing = lastResult.apiTotal - lastResult.records.length;
          verified = lastResult.records.length >= lastResult.apiTotal && !lastResult.error;
          if (verified) { console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`); break; }
          const reason = lastResult.error ? `写入失败: ${lastResult.error}` : `缺 ${missing}`;
          if (attempt < MAX_VERIFY_RETRIES) {
            console.warn(`[scheduler] ⚠️ 对账失败: ${reason}，5s 后重试`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次失败: ${reason}`);
            await notifyWecom('❌ 配送明细采集不完整', `**任务**: ${task.name}\n**日期**: ${dates.from}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**缺**: ${missing}\n**错误**: ${lastResult.error || '无'}`);
            lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): ${lastResult.error ? '写入失败' : `缺 ${missing}`}`;
          }
        }
      }

      // 即时去重守卫：dedupViolations 非空 → /merge 跨次去重失效，full 重采修复(natural_key DISTINCT ON 覆盖) + 告警
      if (lastResult.dedupViolations?.length) {
        const violated = lastResult.dedupViolations.map(v => `${v.bizday}:${v.total}/${v.distinct}`).join(', ');
        console.warn(`[scheduler] ${task.name} 去重失效(${violated})，full 重采修复`);
        const fixCr = await lemeng.collectOnce({ authToken, task: 'delivery', distributionBranch, branchNumsStr }, { mode: 'full', dates: [dates.from, dates.to], limit });
        const fix = fixCr.detail as DeliveryCollectResult;
        const stillBad = fix.dedupViolations?.length ? fix.dedupViolations.map(v => `${v.bizday}:${v.total}/${v.distinct}`).join(',') : '';
        await notifyWecom(stillBad ? '❌ 配送明细去重失效(重采仍异常)' : '⚠️ 配送明细去重失效(已full重采修复)',
          `**任务**: ${task.name}\n**范围**: ${dates.from}~${dates.to}\n**失效**: ${violated}${stillBad ? `\n**重采后仍异常**: ${stillBad}（需人工排查）` : ''}`);
        lastResult = fix;
      }

      // 更新水位线（同 retail：仅落盘成功才推进）
      const finishedAt = new Date();
      const nowMs = finishedAt.getTime();
      const persistOk = !lastResult.error;
      // 多日范围（full 补采 from!=to，如 02:00 reconcile 回溯 3 天）不写当天增量水位线：
      // 否则把 3 天 apiTotal 存进 last_count，会挡住当天 incremental（当天单日总量 < 多日总量整天 skip）。
      const isSingleDay = dates && String(dates.from).slice(0, 10) === String(dates.to).slice(0, 10);
      const newWatermark = {
        date: today,
        last_count: persistOk ? (isSingleDay ? (Number(lastResult.newApiTotal) || 0) : 0) : watermarkLastCount,
        last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
      };
      await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString(), params: { ...params, watermark: newWatermark } }).eq('id', task.id);

      // 不 triggerCompute（先只落明细，汇总后续）
      const finalStatus = lastResult.error ? 'partial' : 'success';
      await writeLog(client, task.id, startedAt, finishedAt, finalStatus, lastResult.records.length, lastResult.error || undefined,
        { mode, skipped: lastResult.skipped, storage_path: lastResult.storagePath, page_failures: lastResult.pageFailures ?? 0, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } });
      console.log(`[scheduler] 配送明细 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);

      // 采集后即时 QA（C0 补当日盲区；与 retail/wholesale 三分支共用）
      await runPostCollectQa(task, client);
      return;
    }

    if (params.task_type === 'wholesale') {
      // ===== 批发销售明细采集（仅 3120；落 Parquet）=====
      console.log(`[scheduler] 批发明细采集: ${task.name}`);
      const branchNumsStr = '99';
      const limit = params.page_size || 200;
      const today = getTodayChina();
      const watermark = params.watermark || {};
      const watermarkLastCount: number = watermarkLastCountFor(params, today);
      // 对账驱动：新一天对账前一日；同一天每小时对账当天；其余纯增量
      const companyId = decodeCompanyId(authToken);
      let mode: 'full' | 'incremental';
      if (opts?.reconcile) {
        // 对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
        const rc = await reconcileTrailingDays(RECONCILE_DAYS,
          (d) => lemeng.count!({ authToken, task: 'wholesale', branchNumsStr }, [d, d]),
          (d) => duckdbParquetCount(`lemeng/wholesale_detail/${companyId}/${d.replace(/-/g, '')}/all.parquet`));
        if (rc.delayed?.length) {
          await notifyWecom('⚠️ 批发数据疑似延迟', `${task.name} ${rc.delayed.join(',')} API=0 但库有数据，后续对账自动补采`).catch(() => {});
        }
        mode = rc.mismatch ? 'full' : 'incremental';
        console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${rc.mismatch ? `不匹配@${rc.mismatch}` : (rc.delayed?.length ? `延迟@${rc.delayed.join(',')}` : '全匹配')} → ${mode}`);
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
        const cr = await lemeng.collectOnce({ authToken, task: 'wholesale', branchNumsStr }, { mode: 'incremental', watermarkLastCount, dates: [dates.from, dates.to], limit });
        lastResult = cr.detail as WholesaleCollectResult;
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }
        verified = !lastResult.error; // 铁律③：增量虽不做条数对账，merge 写入失败 → verified=false
      } else {
        for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
          console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);
          const cr = await lemeng.collectOnce({ authToken, task: 'wholesale', branchNumsStr }, { mode: 'full', dates: [dates.from, dates.to], limit });
          lastResult = cr.detail as WholesaleCollectResult;
          if (lastResult.error.startsWith('Token expired')) {
            await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
            await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
            return;
          }
          if (lastResult.apiTotal === 0) { await writeLog(client, task.id, startedAt, new Date(), 'success', 0); return; }
          // 铁律③：条数达标 AND 落盘无错 才算 verified；transform/merge 失败 → verified=false 触发重试/告警
          const missing = lastResult.apiTotal - lastResult.records.length;
          verified = lastResult.records.length >= lastResult.apiTotal && !lastResult.error;
          if (verified) { console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`); break; }
          const reason = lastResult.error ? `写入失败: ${lastResult.error}` : `缺 ${missing}`;
          if (attempt < MAX_VERIFY_RETRIES) {
            console.warn(`[scheduler] ⚠️ 对账失败: ${reason}，5s 后重试`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次失败: ${reason}`);
            await notifyWecom('❌ 批发明细采集不完整', `**任务**: ${task.name}\n**日期**: ${dates.from}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**缺**: ${missing}\n**错误**: ${lastResult.error || '无'}`);
            lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): ${lastResult.error ? '写入失败' : `缺 ${missing}`}`;
          }
        }
      }
      // 即时去重守卫：dedupViolations 非空 → /merge 跨次去重失效，full 重采修复(natural_key DISTINCT ON 覆盖) + 告警
      if (lastResult.dedupViolations?.length) {
        const violated = lastResult.dedupViolations.map(v => `${v.bizday}:${v.total}/${v.distinct}`).join(', ');
        console.warn(`[scheduler] ${task.name} 去重失效(${violated})，full 重采修复`);
        const fixCr = await lemeng.collectOnce({ authToken, task: 'wholesale', branchNumsStr }, { mode: 'full', dates: [dates.from, dates.to], limit });
        const fix = fixCr.detail as WholesaleCollectResult;
        const stillBad = fix.dedupViolations?.length ? fix.dedupViolations.map(v => `${v.bizday}:${v.total}/${v.distinct}`).join(',') : '';
        await notifyWecom(stillBad ? '❌ 批发明细去重失效(重采仍异常)' : '⚠️ 批发明细去重失效(已full重采修复)',
          `**任务**: ${task.name}\n**范围**: ${dates.from}~${dates.to}\n**失效**: ${violated}${stillBad ? `\n**重采后仍异常**: ${stillBad}（需人工排查）` : ''}`);
        lastResult = fix;
      }
      const finishedAt = new Date();
      const nowMs = finishedAt.getTime();
      const persistOk = !lastResult.error;
      // 多日范围（full 补采 from!=to，如 02:00 reconcile 回溯 3 天）不写当天增量水位线：
      // 否则把 3 天 apiTotal 存进 last_count，会挡住当天 incremental（当天单日总量 < 多日总量整天 skip）。
      const isSingleDay = dates && String(dates.from).slice(0, 10) === String(dates.to).slice(0, 10);
      const newWatermark = {
        date: today,
        last_count: persistOk ? (isSingleDay ? (Number(lastResult.newApiTotal) || 0) : 0) : watermarkLastCount,
        last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
      };
      await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString(), params: { ...params, watermark: newWatermark } }).eq('id', task.id);
      const finalStatus = lastResult.error ? 'partial' : 'success';
      await writeLog(client, task.id, startedAt, finishedAt, finalStatus, lastResult.records.length, lastResult.error || undefined,
        { mode, skipped: lastResult.skipped, storage_path: lastResult.storagePath, page_failures: lastResult.pageFailures ?? 0, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } });
      console.log(`[scheduler] 批发明细 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);

      // 采集后即时 QA（C0 补当日盲区；与 retail/delivery 三分支共用）
      await runPostCollectQa(task, client);
      return;
    }

    // ===== 订单明细采集（默认） =====
    const today = getTodayChina();
    const branchNums = params.branch_nums || [];
    const branchNumsStr = branchNums.join(',');
    const pageSize = params.page_size || 200;

    // 模式判定：新一天 / 距上次全量≥55min / 无水位线 → full（覆盖+核对）；否则 incremental（续采尾部）
    const watermark = params.watermark || {};
    const watermarkLastCount: number = watermarkLastCountFor(params, today);
    // 对账驱动：新一天对账前一日(通过 incremental / 失败 full)；同一天每小时对账当天；其余纯增量
    const companyId = decodeCompanyId(authToken);
    let mode: 'full' | 'incremental';
    if (opts?.reconcile) {
      // 新一天：对账最近 RECONCILE_DAYS 天（不只前一日，兜晚落账单据）
      const rc = await reconcileTrailingDays(RECONCILE_DAYS,
        (d) => lemeng.count!({ authToken, task: 'retail', branchNums, branchNumsStr }, [d, d]),
        (d) => duckdbParquetCount(`lemeng/retail_detail/${companyId}/${d}/all.parquet`));
      if (rc.delayed?.length) {
        await notifyWecom('⚠️ 销售数据疑似延迟', `${task.name} ${rc.delayed.join(',')} API=0 但库有数据，后续对账自动补采`).catch(() => {});
      }
      mode = rc.mismatch ? 'full' : 'incremental';
      console.log(`[scheduler] ${task.name} 对账最近${RECONCILE_DAYS}天 ${rc.mismatch ? `不匹配@${rc.mismatch}` : (rc.delayed?.length ? `延迟@${rc.delayed.join(',')}` : '全匹配')} → ${mode}`);
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
      const cr = await lemeng.collectOnce({ authToken, task: 'retail', branchNums, branchNumsStr }, { mode: 'incremental', watermarkLastCount, dates, pageSize });
      lastResult = cr.detail as CollectResult;

      if (lastResult.error.startsWith('Token expired')) {
        await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
        await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
        return;
      }
      verified = !lastResult.error; // 铁律③：增量虽不做条数对账，merge 写入失败 → verified=false
    } else {
      // 全量：保留对账重试循环
      for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
        console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);

        const cr = await lemeng.collectOnce({ authToken, task: 'retail', branchNums, branchNumsStr }, { mode: 'full', dates, pageSize });
        lastResult = cr.detail as CollectResult;

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

        // 对账（铁律③：条数达标 AND 落盘无错 才算 verified；transform/merge 失败 → verified=false 触发重试/告警）
        const missing = lastResult.apiTotal - lastResult.records.length;
        verified = lastResult.records.length >= lastResult.apiTotal && !lastResult.error;

        if (verified) {
          console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`);
          break;
        }

        const reason = lastResult.error ? `写入失败: ${lastResult.error}` : `缺少 ${missing} 条`;
        if (attempt < MAX_VERIFY_RETRIES) {
          console.warn(`[scheduler] ⚠️ 对账失败: ${reason}，5 秒后重试...`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次均失败: ${reason}`);
          await notifyWecom(
            '❌ 定时采集不完整（已重试3次）',
            `**任务**: ${task.name}\n**日期**: ${dates[0]}\n**采集数**: ${lastResult.records.length}\n**API总数**: ${lastResult.apiTotal}\n**缺少**: ${missing} 条\n**错误**: ${lastResult.error || '无'}\n**建议**: 请检查网络或手动重新采集`
          );
          lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): ${lastResult.error ? '写入失败' : `缺少 ${missing} 条`}`;
        }
      }
    }

    // 更新水位线：仅当本次落盘成功（无 error）才推进 last_count；失败保持旧水位线，下次多重叠
    const finishedAt = new Date();
    const nowMs = finishedAt.getTime();
    const persistOk = !lastResult.error;
    // 多日范围（full 补采 from!=to，如 02:00 reconcile 回溯 3 天）不写当天增量水位线：
    // 否则把 3 天 apiTotal 存进 last_count，会挡住当天 incremental（当天单日总量 < 多日总量整天 skip）。
    const isSingleDay = Array.isArray(dates) && dates.length === 2 && dates[0] === dates[1];
    const newWatermark = {
      date: today,
      last_count: persistOk ? (isSingleDay ? (Number(lastResult.newApiTotal) || 0) : 0) : watermarkLastCount,
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

    // L4 采集后即时 QA：D1+D2 去重守护 + C1 明细↔聚合对账 + C0 源API count↔明细 count（受影响源当日，三分支共用 helper）
    await runPostCollectQa(task, client);

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
        page_failures: lastResult.pageFailures ?? 0,
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
 * 采集任务 manifest 工厂：collect_tasks 每行 → 一个 JobManifest（动态 cron，schedule 取自 task.schedule_cron）。
 * 宿主导入 COLLECTORS 分发到数据源插件；本 job 只保留编排（凭证/模式/对账/水位线/告警）。
 */
export function collectManifest(task: CollectTask): JobManifest {
  return {
    id: task.id,
    schedule: task.schedule_cron,
    run: async (): Promise<JobResult> => {
      await executeTask(task);
      return { status: 'ok' };
    },
  };
}
