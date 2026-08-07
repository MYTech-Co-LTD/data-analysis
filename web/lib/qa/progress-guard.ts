// web/lib/qa/progress-guard.ts
// 采集"无进展"守卫（仅 3120/64188 销售明细采集，function_slug='collect-lemeng'）：
// 任务在跑（collect_logs 有行）但连续 N 次 0 行、同时源 api_total 在增长 → 结构性损坏
// （如水位线卡死/查询失效/增量被跳过），立即告警，不等次日 09:15 对账才暴露。
// 背景 2026-08-07：64188 品品甜当天 0 行根因即"水位线跨日不重置+闭包陈旧"——api_total
// 持续增长（4788→5163）但每次 run 都 skipped、0 行，C0/C1 守卫只比内部数量/金额抓不到，
// 24h 后对账才发现。此守卫用现有 collect_logs 的 response_summary（api_total）零额外 API 调用补盲。
// 数据源：collect_logs（started_at, rows_collected, response_summary->verification->api_total）
// 判定：最近 PROGRESS_RUNS 条全部 rows_collected==0 且窗口内 api_total 增长 ≥ MIN_GROWTH → fail。
// 冷却：同一任务 SUPPRESS_MS 内不重复告警（模块级 Map，进程重启后重置，最多多告一次）。
import type { CheckResult, QaTrigger } from './types';

export const PROGRESS_RUNS = 6;      // 连续 6 次（约 30 分钟）0 行才算"无进展"
export const MIN_GROWTH = 100;       // 窗口内 api_total 至少增长这么多行才判定"源在涨"（滤 1-2 行抖动）
export const SUPPRESS_MS = 60 * 60 * 1000; // 告警冷却 1 小时

const lastAlertAt = new Map<string, number>();

interface ProgressLog {
  started_at: string;
  rows_collected: number | null;
  response_summary: { verification?: { api_total?: string | number } } | null;
}

export interface ProgressGuardOpts {
  db: { from(t: string): any };
  task: { id: string; name: string; function_slug: string };
  runId: string;
  trigger: QaTrigger;
}

export async function runProgressGuard(opts: ProgressGuardOpts): Promise<{ result: CheckResult; notify: boolean }> {
  const { db, task, runId, trigger } = opts;
  // 仅 3120/64188 销售明细采集
  if (task.function_slug !== 'collect-lemeng') {
    return { result: passResult(runId, trigger, task), notify: false };
  }

  try {
    const { data: logs } = await db.from('collect_logs')
      .select('started_at,rows_collected,response_summary')
      .eq('task_id', task.id)
      .order('started_at', { ascending: false })
      .limit(PROGRESS_RUNS);
    const rows = (logs ?? []) as ProgressLog[];
    // 运行不足 / 采集停了（无新日志）不判定——"采集停了"由 collect_stall 兜底
    if (rows.length < PROGRESS_RUNS) return { result: passResult(runId, trigger, task), notify: false };

    // 全部 0 行？
    const allZero = rows.every((l) => Number(l.rows_collected ?? 0) === 0);
    if (!allZero) return { result: passResult(runId, trigger, task), notify: false };

    // 窗口内 api_total 增长？response_summary.verification.api_total 为最新一次 count（缺省 -1 跳过）
    const apiTotals = rows.map((l) => Number(l.response_summary?.verification?.api_total ?? -1)).filter((n) => n >= 0);
    if (apiTotals.length < PROGRESS_RUNS) return { result: passResult(runId, trigger, task), notify: false };
    const firstApi = apiTotals[apiTotals.length - 1]; // 最早
    const lastApi = apiTotals[0];                     // 最新
    if (lastApi - firstApi < MIN_GROWTH) return { result: passResult(runId, trigger, task), notify: false };

    // 冷却
    const now = Date.now();
    const notify = (lastAlertAt.get(task.id) ?? 0) < now - SUPPRESS_MS;
    if (notify) lastAlertAt.set(task.id, now);

    const result: CheckResult = {
      run_id: runId,
      trigger,
      check_type: 'C6',
      check_name: `progress:${task.name}`,
      status: 'fail',
      diff: lastApi - firstApi,
      detail: [{
        task_id: task.id,
        task_name: task.name,
        consecutive_zero: PROGRESS_RUNS,
        api_from: firstApi,
        api_to: lastApi,
        api_growth: lastApi - firstApi,
        reason: '任务在跑但连续 30 分钟 0 行，同时源 api_total 在增长——疑似水位线/查询失效，请排查',
      }],
    };
    return { result, notify };
  } catch (e: any) {
    console.error('[progress-guard] 检查失败:', e?.message ?? e);
    return { result: passResult(runId, trigger, task), notify: false };
  }
}

function passResult(runId: string, trigger: QaTrigger, task: { id: string; name: string }): CheckResult {
  return {
    run_id: runId,
    trigger,
    check_type: 'C6',
    check_name: `progress:${task.name}`,
    status: 'pass',
    diff: null,
    detail: null,
  };
}
