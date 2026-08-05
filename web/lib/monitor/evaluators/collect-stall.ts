import type { EvalDeps, EvalResult, Evaluator } from '../types';

// 采集停告警（架构 §8.1 / spec 2026-08-05-collect-stall-guard-design）
// 数据源：collect_tasks.last_run_at（心跳，无埋点）。锁卡住/executeTask 挂起时 collect_logs 无新行，
// collect_fail 抓不到（全是陈旧 success），故用 last_run_at 陈旧检测兜底。
// rule.target = task_id；判定 enabled=true 且 now - last_run_at > 阈值 → firing collect_stall:<task_id>。
// 阈值按 cron 周期推导：分钟级任务（*/5、3-59/5、*）→ 15 分钟（3 周期）；日任务（0 3 * * * 等）→ 26h。
// rule.threshold.stall_minutes 可每任务覆盖默认阈值。
// context = {task_id, task_name, schedule_cron, elapsed_minutes, threshold_minutes, last_run_at, reason}
// 任务未启用 / 从未运行（last_run_at 为空）→ 不 firing（同 collect_fail 无日志不告警）。

export interface CollectStallHit {
  firing: boolean;
  reason: string;
  taskId: string;
  taskName: string;
  elapsedMinutes: number;
  thresholdMinutes: number;
  lastRunAt: string;
}

// 阈值：minute 字段含 * 或 /（*/5、3-59/5、* * * * *）→ 15 分钟；否则视为日任务（0 3 * * * / 0 4 * * *）→ 26h。
// 用 minute 字段判断而非整个 cron 子串匹配，避免「0 3 * * *」这种含 * 的日任务被误判成分钟级。
export function stallMinutesFor(cron: string): number {
  const minuteField = (cron ?? '').trim().split(/\s+/)[0] ?? '';
  if (minuteField.includes('*') || minuteField.includes('/')) return 15;
  return 26 * 60;
}

// 全量扫描：返回所有陈旧任务（brief 接口，deps-only）。engine 的 evalCollectStall 复用它按 rule.target 过滤。
export async function collectStallEvaluator(
  deps: EvalDeps,
  thresholdOverrides: Record<string, number> = {},
): Promise<CollectStallHit[]> {
  const tasks = await deps.getCollectTasks();
  const nowMs = deps.now.getTime();
  const hits: CollectStallHit[] = [];

  for (const t of tasks) {
    if (!t.enabled || !t.last_run_at) continue;
    const lastMs = new Date(t.last_run_at).getTime();
    if (Number.isNaN(lastMs)) continue;
    const elapsedMinutes = Math.round((nowMs - lastMs) / 60000);
    const thresholdMinutes = thresholdOverrides[t.id] ?? stallMinutesFor(t.schedule_cron);
    if (elapsedMinutes > thresholdMinutes) {
      hits.push({
        firing: true,
        reason: `任务「${t.name}」采集已停止 ${elapsedMinutes} 分钟（阈值 ${thresholdMinutes} 分钟）`,
        taskId: t.id,
        taskName: t.name,
        elapsedMinutes,
        thresholdMinutes,
        lastRunAt: t.last_run_at,
      });
    }
  }
  return hits;
}

// engine Evaluator：per-rule（rule.target = task_id），alert_key = collect_stall:<task_id>。
export const evalCollectStall: Evaluator = async (rule, deps): Promise<EvalResult> => {
  const taskId = rule.target ?? '';
  const alertKey = `collect_stall:${taskId}`;
  if (!taskId) {
    return { firing: false, alert_key: alertKey, context: { reason: 'rule 缺 target(task_id)' } };
  }

  // 每任务阈值覆盖：rule.threshold.stall_minutes > 0 时生效
  const stallMinutes = Number(rule.threshold?.stall_minutes);
  const overrides =
    Number.isFinite(stallMinutes) && stallMinutes > 0 ? { [taskId]: stallMinutes } : {};

  const hits = await collectStallEvaluator(deps, overrides);
  const hit = hits.find((h) => h.taskId === taskId);

  return {
    firing: !!hit,
    alert_key: alertKey,
    context: hit
      ? {
          task_id: hit.taskId,
          task_name: hit.taskName,
          elapsed_minutes: hit.elapsedMinutes,
          threshold_minutes: hit.thresholdMinutes,
          last_run_at: hit.lastRunAt,
          reason: hit.reason,
        }
      : { task_id: taskId, reason: '未陈旧、任务禁用或尚未运行（无心跳）' },
  };
};
