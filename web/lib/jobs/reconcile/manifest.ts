/* eslint-disable @typescript-eslint/no-explicit-any -- P1 纯搬移：job 函数体从 scheduler.ts 原样搬入（不改进），保留既有 any 用法；P1 冻结后再逐步收紧 */
// web/lib/jobs/reconcile/manifest.ts
// 对账类定时 job（两个，均从 scheduler.ts 原样搬入 run，不改进）：
//   __daily_reconcile（每日 02:00/12:00/19:00 明细对账）：
//     retail/delivery/wholesale 3 天窗口 full 补晚落账单；executeTask(reconcile:true) 内部按源对最近 RECONCILE_DAYS 天。
//   __daily_source_reconcile（每日 09:07 源对账）：
//     pipeline 表 SUM vs DuckDB parquet SUM，差>1元告警；含 P2a 金额级源校验（runSourceAmountCheck）。
// P1：cron 注册由薄 scheduler 按 manifest.schedule 完成；锁/水位线机制随 job 搬迁（runningTasks + tryAcquireLock）。
import { createClient } from '@insforge/sdk';
import type { JobManifest, JobResult } from '../../contracts';
import { decodeCompanyId, fetchWithTimeout, getDateOffsetChina, REQUEST_TIMEOUT, sumRetailApi } from '../../collect';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { executeTask } from '../collect/manifest';
import { AGENT_API_KEY, DUCKDB_URL, INSFORGE_API_BASE, INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

// DuckDB 查 parquet SUM（对账用：parquet 源 SUM vs compute 表 SUM）
async function duckdbParquetSum(pathGlob: string, valueCol: string): Promise<number> {
  try {
    const r = await fetchWithTimeout(`${DUCKDB_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY }, body: JSON.stringify({ sql: `SELECT COALESCE(round(sum(CAST(${valueCol} AS DECIMAL(14,2))),2),0) AS s FROM read_parquet('s3://lemeng-datasource/${pathGlob}')` }) }, REQUEST_TIMEOUT);
    const d = await r.json();
    return d.data?.[0]?.s || 0;
  } catch { return 0; }
}

// P2a 金额级源校验：完结日（昨日）API 金额 vs parquet 金额。
// C0 只对数量（countposorderdetail 无金额汇总），若 sale_money 字段映射/口径错会系统性差金额且无告警。
// 每日 09:07 源对账时跑一次：拉取零售源昨日明细求和（只读 sumRetailApi），与 parquet 对比，1% 容差。
async function runSourceAmountCheck(client: any, yesterday: string): Promise<string[]> {
  const alerts: string[] = [];
  const { data: retailTasks } = await client.database.from('collect_tasks')
    .select('id, source_id, params').eq('function_slug', 'collect-lemeng').eq('enabled', true);
  for (const task of (retailTasks ?? []) as any[]) {
    try {
      const { data: cred } = await client.database.from('auth_credentials').select('credential_data').eq('source_id', task.source_id).single();
      let token = '';
      try { token = JSON.parse(cred?.credential_data || '{}').token || ''; } catch { /* ignore */ }
      if (!token) continue;
      const authToken = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
      const companyId = decodeCompanyId(authToken);
      const bn: number[] = task.params?.branch_nums || [];
      const api = await sumRetailApi(authToken, bn, bn.join(','), [yesterday, yesterday]);
      if (api.count < 0) { console.warn(`[scheduler] P2a ${companyId} API金额取数失败`); continue; }
      if (api.count <= 0) continue; // 当日源无数据
      const parquetSum = await duckdbParquetSum(`lemeng/retail_detail/${companyId}/${yesterday}/all.parquet`, 'sale_money');
      const diff = Math.round((parquetSum - api.sum) * 100) / 100;
      const ok = Math.abs(diff) <= Math.max(1, api.sum * 0.01); // 1% 容差
      console.log(`[scheduler] P2a 源金额 ${companyId} ${yesterday}: API=${api.sum} parquet=${parquetSum} 差=${diff} ${ok ? '✅' : '❌'}`);
      if (!ok) alerts.push(`P2a ${companyId} ${yesterday}: API金额 ${api.sum} / parquet ${parquetSum} / 差 ${diff}`);
    } catch (e: any) {
      console.error(`[scheduler] P2a 源金额校验 ${task.id} 异常:`, e?.message ?? e);
    }
  }
  return alerts;
}

// 每日 02:00 明细采集对账（retail/delivery/wholesale，3天窗口 full 补晚落账单）。
// 与常规 8-23 增量采集解耦：2点此 job 传 reconcile=true → isNewDay 式对账最近3天+full 补采；
// 8点起常规 cron 调 executeTask(task)（无 reconcile）→ 只当天增量，不对账。
export const dailyReconcileManifest: JobManifest = {
  id: '__daily_reconcile',
  schedule: '0 2,12,19 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__daily_reconcile';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      const hour = new Date().getHours();
      console.log(`[scheduler] ⏰ 每日${String(hour).padStart(2, '0')}:00 明细对账触发（3天窗口）`);
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const { data: allTasks, error } = await client.database.from("collect_tasks")
        .select("id, name, source_id, function_slug, schedule_cron, params")
        .eq("enabled", true);
      if (error) throw new Error(`查询采集任务失败: ${error.message}`);
      // 三个明细源均纳入对账（retail/delivery/wholesale）；executeTask 内按 task_type 走各自 reconcile 分支
      const RECONCILE_SLUGS = ["collect-lemeng", "collect-delivery", "collect-wholesale"];
      const tasks = (allTasks ?? []).filter((t: any) => RECONCILE_SLUGS.includes(t.function_slug));
      for (const task of tasks) {
        try { await executeTask(task, { reconcile: true }); }
        catch (e: any) { console.error(`[scheduler] ${String(hour).padStart(2, '0')}:00对账 ${task.name} 异常:`, e?.message ?? e); }
      }
      console.log(`[scheduler] 每日${String(hour).padStart(2, '0')}:00 明细对账完成`);
    } catch (e: any) {
      console.error("[scheduler] 每日对账异常:", e?.message ?? e);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};

/**
 * 每日源对账 job（09:07）：pipeline 表 SUM vs DuckDB parquet SUM，差>1元告警。
 * 确保 compute 表与 parquet 源精确一致，任何计算/去重 bug 都能自动发现。
 */
export const sourceReconcileManifest: JobManifest = {
  id: '__daily_source_reconcile',
  schedule: '7 9 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__daily_source_reconcile';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
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
      // P2a 金额级源校验：API 金额 vs parquet 金额（C0 只对数量，抓 sale_money 字段口径错）
      alerts.push(...(await runSourceAmountCheck(client, yesterday).catch((e: any) => { console.error('[scheduler] P2a 源金额校验异常:', e?.message ?? e); return [] as string[]; })));
      if (alerts.length) await notifyWecom('⚠️ 每日源对账异常', `**日期**: ${yesterday}\n${alerts.join('\n')}`);
      else console.log(`[scheduler] ✅ 每日源对账全通过: ${yesterday}`);
    } catch (e: any) { console.error('[scheduler] 每日源对账异常:', e?.message ?? e); }
    finally { runningTasks.delete(JOB_KEY); }
    return { status: 'ok' };
  },
};
