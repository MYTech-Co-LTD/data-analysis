/* eslint-disable @typescript-eslint/no-explicit-any -- P1 纯搬移：job 函数体从 scheduler.ts 原样搬入（不改进），保留既有 any 用法；P1 冻结后再逐步收紧 */
// web/lib/jobs/qa/manifest.ts
// L4 数据质量巡检：每日 09:15 全量跑 D1/D2/C2（__qa_full），错开 09:07 源对账。
// runDailyQa/runPostCollectQa 从 scheduler.ts 原样搬入（不改进）——runPostCollectQa 供 collect job 采集后即时 QA 复用。
// P1：cron 注册由薄 scheduler 按 manifest.schedule 完成；锁/水位线机制随 job 搬迁（runningTasks + tryAcquireLock）。
import { createClient } from '@insforge/sdk';
import type { JobManifest, JobResult } from '../../contracts';
import { fetchWithTimeout, getDateOffsetChina, REQUEST_TIMEOUT } from '../../collect';
import { notifyWecom } from '../../notify';
import { runQaChecks } from '../../qa-runner';
import { runC0Checks } from '../../qa/c0-runner';
import { runC1Checks } from '../../qa/c1-runner';
import { runProgressGuard } from '../../qa/progress-guard';
import { partitionQaResults } from '../../qa/alert';
import detailSources from '../../qa/config/detail-sources.json';
import { duckQuery } from '../../qa/duck';
import { buildDayGlob } from '../../qa/d1';
import type { DetailSource } from '../../qa/types';
import { tryAcquireLock } from '../../scheduler-lock';
import { AGENT_API_KEY, DUCKDB_URL, INSFORGE_API_BASE, INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

// L4 数据质量巡检执行器（Task 9）：DB(postgrest rpc+from) + duck(duckdb HTTP) 双适配器，
// 调 runQaChecks 跑 D1/D2/C2；失败推企微告警。trigger: 'cron' 每日 09:15 全量 / 'collect' 采集后按源 D1。
async function runDailyQa(trigger: 'cron' | 'collect', checks?: string[], dateFrom?: string, dateTo?: string, d1Globs?: Record<string, string>) {
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: async (fn: string, body: Record<string, unknown>) => {
      const r = await fetchWithTimeout(`${POSTGREST_URL}/rpc/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
      }, REQUEST_TIMEOUT);
      const json = await r.json();
      if (!r.ok) return { error: json };
      return { data: json };
    },
    from: (t: string) => client.database.from(t),
  } as any;
  // collect 触发（采集后即时 QA，executeTask 内）：duck 查询挂 30s 超时防挂起持锁；
  // cron 全量（09:15）保留 0=不设超时（D1 全 glob 扫描可能 >30s，且不占 executeTask 锁）。
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY!, sql, trigger === 'collect' ? REQUEST_TIMEOUT : 0);
  // 随机后缀防同毫秒 run_id 撞 qa_logs 的 UNIQUE 约束（采集后 hook 与每日 09:15 可能同毫秒）
  const runId = `${trigger}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const results = await runQaChecks({ runId, trigger, db, duck, checks, dateFrom, dateTo, d1Globs });
  // C0 源API count ↔ 明细 count（分毫不差：库==源）——每日 job 也要验证「采集=源」，不只手动
  // autoBackfill=true：默认 7 天窗口内任一天 missing（库<源）→ 当日 full 重采收敛 ≤3（缺失日自动补采），
  // 与采集后即时 QA（runPostCollectQa）同策略，确保每日 09:15 能自愈漏采而非只告警。
  if (!checks || checks.some((c) => c.startsWith('C0:'))) {
    results.push(...await runC0Checks({ client, duck, runId, trigger, checks, autoBackfill: true }));
  }
  // fail/error（真异常）与 no-data（数据未到）分开告警：no-data 不混入 fail/error 告警，走独立「数据未到」。
  const { failed, noData } = partitionQaResults(results);
  if (failed.length) {
    await notifyWecom('⚠️ 每日数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 10).map((r) => `${r.check_type}:${r.check_name} ${r.status}`).join('\n')}`).catch(() => {});
  }
  if (noData.length) {
    await notifyWecom('⏳ 每日数据未到', `${noData.length} 项数据未到（源无数据/parquet 未创建）:\n${noData.slice(0, 10).map((r) => `${r.check_type}:${r.check_name}`).join('\n')}`).catch(() => {});
  }
  console.log(`[scheduler] __qa_${trigger}: ${results.length} 检查, 失败 ${failed.length}, 未到 ${noData.length}`);
  return results;
}

/**
 * 采集后即时 QA（三源共用）：D1+D2 去重守护 + C1 明细↔聚合对账 + C0 源API count↔明细 count（受影响源当日）。
 *  C0 用当日单日窗口 + coarseToday（粗粒度健康检查，不 autoBackfill，避免当天流式增长触发反复 full 重采）；
 *  C6 采集无进展守卫（仅零售任务）兜"任务在跑但 0 行、源在涨"的结构性损坏，立即告警。
 *  QA 失败只记日志不阻断采集（parquet 已落，采集是主任务）。
 */
async function runPostCollectQa(
  task: { id: string; name: string; source_id: string; function_slug: string; params: any },
  client: any,
) {
  try {
    const src = (detailSources as DetailSource[]).find((s) => s.function_slug === task.function_slug);
    if (!src) return;
    const todayCompact = getDateOffsetChina(0).replace(/-/g, '');
    const todayIso = getDateOffsetChina(0);
    // D1+D2 去重守护（当日分区，buildDayGlob 按源目录格式把日期段替换成具体日，避免每 5 分钟全库重扫）
    try {
      const dayGlob = buildDayGlob(src, todayCompact);
      await runDailyQa('collect', [`D1:${src.name}`, `D2:${src.name}`], todayCompact, todayCompact, { [src.name]: dayGlob });
    } catch (e: any) { console.error('[scheduler] 采集后 D1/D2 失败:', e?.message ?? e); }
    // C1 明细↔聚合对账（受影响源当日单日，非 7 天）+ 自动 /compute 重算 retry；C1 失败不阻断采集（parquet 已落，采集是主任务）
    try {
      const c1Client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const c1Db = {
        rpc: async (fn: string, body: Record<string, unknown>) => {
          const r = await fetchWithTimeout(`${POSTGREST_URL}/rpc/${fn}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
          }, REQUEST_TIMEOUT);
          const json = await r.json();
          if (!r.ok) return { error: json };
          return { data: json };
        },
        from: (t: string) => c1Client.database.from(t),
      } as any;
      // 采集后 QA（executeTask 内）：duck 查询挂 30s 超时防挂起持锁（C1 当日单日窗口，快查询）
      const c1Duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY!, sql, REQUEST_TIMEOUT);
      // 随机后缀防同毫秒 run_id 撞 qa_logs UNIQUE 约束（与 runDailyQa 同模式）
      const c1RunId = `collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await runC1Checks({ db: c1Db, duck: c1Duck, runId: c1RunId, trigger: 'collect', checks: [`C1:${src.name}`], window: { from: todayIso, to: todayIso } });
    } catch (e: any) { console.error('[scheduler] 采集后 C1 失败:', e?.message ?? e); }
    // C0 源API count ↔ 明细 count：当天窗口用粗粒度健康检查（coarseToday，lib≥50% api 即 pass），
    // 不触发 autoBackfill——当天源持续增长，full 重采移动目标无意义且反复打乐檬 API；
    // 精确对账+补采交给每日 09:15 完结日窗口（coarseToday 不传）。
    try {
      const c0RunId = `collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await runC0Checks({ client, duck: (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY!, sql, REQUEST_TIMEOUT), runId: c0RunId, trigger: 'collect', checks: [`C0:${src.name}`], window: { from: todayIso, to: todayIso }, autoBackfill: false, coarseToday: true });
    } catch (e: any) { console.error('[scheduler] 采集后 C0 失败:', e?.message ?? e); }
    // C6 采集无进展守卫（仅 3120/64188 销售明细 collect-lemeng）：任务在跑但连续 30 分钟 0 行、
    // 同时源 api_total 在增长 → 结构性损坏（水位线/查询失效），立即告警，不等次日对账。
    // 只在 fail 时写 qa_logs（健康守卫不刷 pass 行，qa_logs 每 5 分钟已有很多 C0/C1 记录）。
    try {
      const pgRunId = `collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pg = await runProgressGuard({ db: client.database, task, runId: pgRunId, trigger: 'collect' });
      if (pg.result.status === 'fail') {
        await client.database.from('qa_logs').insert([pg.result]);
        if (pg.notify) {
          await notifyWecom(
            '⚠️ 采集无进展（当天漏采风险）',
            `**任务**: ${task.name}\n${(pg.result.detail as any[])?.[0]?.reason || '连续 30 分钟 0 行但源在增长'}`
          ).catch(() => {});
        }
      }
    } catch (e: any) { console.error('[scheduler] 采集后 C6 无进展守卫失败:', e?.message ?? e); }
  } catch (e: any) {
    console.error('[scheduler] 采集后 QA 异常:', e?.message ?? e);
  }
}

/**
 * 每日数据质量巡检 job（__qa_full，09:15）：全量跑 D1/D2/C2，错开 09:07 源对账。
 * L4 spec：每日全量 QA 定时（Task 9）。
 */
export const qaFullManifest: JobManifest = {
  id: '__qa_full',
  schedule: '15 9 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__qa_full';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try { await runDailyQa('cron'); }
    catch (e: any) { console.error('[scheduler] __qa_full 异常:', e?.message ?? e); }
    finally { runningTasks.delete(JOB_KEY); }
    return { status: 'ok' };
  },
};

export { runPostCollectQa };
