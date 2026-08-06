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

// 中国时区当前小时（0-23）。与 collect.ts 的 +8h 口径一致（中国固定 UTC+8、无夏令时）：
// 显式用 Intl Asia/Shanghai 取墙钟小时（不受服务器本地时区影响），失败兜底 +8h 平移。
function chinaHourOf(date: Date): number {
  try {
    const h = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getHours();
    if (!Number.isNaN(h)) return h;
  } catch {
    /* fallthrough */
  }
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
}

// 活跃小时集合转人读文案：连续区间折叠为 `8-23`、单值 `3`、多段 `0,5,10,15,20`。
function formatActiveHours(hours: Set<number>): string {
  const sorted = [...hours].sort((a, b) => a - b);
  if (sorted.length === 0) return '全天';
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const h = sorted[i];
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = h;
    prev = h;
  }
  return ranges.join(',');
}

// 解析 cron 小时字段（第 2 字段）为活跃小时集合（0-23）。分钟级字段（*/5 等）不影响小时。
// 支持：`*` → [0..23]；单值 `3` → [3]；区间 `8-23` → [8..23]；区间+步长 `8-23/2` → [8,10,...,22]；
// 逗号列表 `1,3,5` → 各子项并集；脏 cron（缺字段/解析失败）→ 全天活跃（保守，避免误报停采窗口外）。
export function cronActiveHours(cron: string): Set<number> {
  const hourField = (cron ?? '').trim().split(/\s+/)[1];
  if (!hourField || hourField === '*') return new Set(Array.from({ length: 24 }, (_, i) => i));
  const hours = new Set<number>();
  for (const part of hourField.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (Number.isNaN(step) || step < 1) continue;
    if (range === '*') {
      for (let h = 0; h < 24; h += step) hours.add(h);
    } else if (range.includes('-')) {
      const [s, e] = range.split('-').map((x) => parseInt(x, 10));
      if (Number.isNaN(s) || Number.isNaN(e)) continue;
      for (let h = s; h <= e; h += step) hours.add(h);
    } else {
      const v = parseInt(range, 10);
      if (!Number.isNaN(v)) hours.add(v);
    }
  }
  return hours.size > 0 ? hours : new Set(Array.from({ length: 24 }, (_, i) => i));
}

// 全量扫描：返回所有任务的评估结果（brief 接口，deps-only）。engine 的 evalCollectStall 复用它按 rule.target 过滤。
// cron 活跃窗口判定（修复夜间误报）：当前中国时区小时不在 cron 活跃小时 → 正常停采，返回 firing:false（不告警），
// reason 标「停采窗口外」；活跃窗口内且 last_run_at 陈旧 > 阈值 → firing。
// nowHour 仅测试注入（中国时区小时 0-23），缺省从 deps.now 推导。
export async function collectStallEvaluator(
  deps: EvalDeps,
  thresholdOverrides: Record<string, number> = {},
  nowHour?: number,
): Promise<CollectStallHit[]> {
  const tasks = await deps.getCollectTasks();
  const nowMs = deps.now.getTime();
  const chinaHour = nowHour ?? chinaHourOf(deps.now);
  const hits: CollectStallHit[] = [];

  for (const t of tasks) {
    if (!t.enabled || !t.last_run_at) continue;
    const lastMs = new Date(t.last_run_at).getTime();
    if (Number.isNaN(lastMs)) continue;
    const elapsedMinutes = Math.round((nowMs - lastMs) / 60000);
    const thresholdMinutes = thresholdOverrides[t.id] ?? stallMinutesFor(t.schedule_cron);

    // 停采窗口外（如夜间 8-23 窗口外的 23:55-次日 8:00）：正常停采，不判定采集停
    const activeHours = cronActiveHours(t.schedule_cron);
    if (!activeHours.has(chinaHour)) {
      hits.push({
        firing: false,
        reason: `停采窗口外（当前 ${chinaHour} 点，活跃 ${formatActiveHours(activeHours)} 点），属正常停采`,
        taskId: t.id,
        taskName: t.name,
        elapsedMinutes,
        thresholdMinutes,
        lastRunAt: t.last_run_at,
      });
      continue;
    }

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
    // hit 可能是「停采窗口外」的非 firing 记录（reason 含停采窗口外），不能仅凭存在判定 firing
    firing: hit?.firing === true,
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
