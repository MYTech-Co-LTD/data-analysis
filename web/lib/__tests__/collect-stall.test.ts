// web/lib/__tests__/collect-stall.test.ts
// 采集停 evaluator 单测：mock getCollectTasks（last_run_at 新旧 + 不同 cron），
// 断言 firing/不 firing + 阈值（stallMinutesFor）+ cron 活跃窗口（cronActiveHours）正确。
// 活跃窗口判定：当前中国时区小时不在 cron 活跃小时 → 正常停采（不 firing，reason 标「停采窗口外」）。
import { describe, it, expect } from 'vitest';
import {
  collectStallEvaluator,
  evalCollectStall,
  stallMinutesFor,
  cronActiveHours,
} from '../monitor/evaluators/collect-stall';
import type { EvalDeps, MonitorRule } from '../monitor/types';

// NOW = 中国 20:00（`*/5 8-23` 活跃窗口内）；NIGHT_NOW = 中国 02:00（8-23 窗口外）
const NOW = new Date('2026-08-05T12:00:00Z');
const NIGHT_NOW = new Date('2026-08-05T18:00:00Z');

// 中国时区小时常量（collectStallEvaluator 的 nowHour 测试注入，避免依赖测试机器时区）
const HOUR_NIGHT = 2; // 夜间（8-23 窗口外）
const HOUR_ACTIVE = 20; // `*/5 8-23` 活跃窗口内
const HOUR_DAILY_RUN = 3; // 日任务 `0 3 * * *` 活跃小时

type CollectTask = { id: string; name: string; schedule_cron: string; enabled: boolean; last_run_at: string | null };

function makeTask(over: Partial<CollectTask> = {}): CollectTask {
  return {
    id: 'task-1',
    name: '测试采集任务',
    schedule_cron: '*/5 * * * *',
    enabled: true,
    last_run_at: '2026-08-05T11:50:00Z', // 10 分钟前（默认新鲜）
    ...over,
  };
}

function makeDeps(tasks: CollectTask[], now: Date = NOW): EvalDeps {
  return {
    now,
    probe: async () => ({ ok: true, latencyMs: 1 }),
    getCredentialToken: async () => null,
    getCollectLogs: async () => [],
    getCollectTasks: async () => tasks,
  };
}

function makeRule(taskId: string, threshold: Record<string, any> = {}): MonitorRule {
  return {
    id: 1,
    name: '采集停止·测试',
    check_type: 'collect_stall',
    target: taskId,
    threshold,
    severity: 'high',
    touser: null,
    template: '任务「{task_name}」采集已停止 {elapsed_minutes} 分钟',
    suppress_window_seconds: 1800,
    enabled: true,
  };
}

describe('stallMinutesFor 阈值推导', () => {
  it('分钟级 cron（*/5、3-59/5、*）→ 15 分钟', () => {
    expect(stallMinutesFor('*/5 * * * *')).toBe(15);
    expect(stallMinutesFor('3-59/5 * * * *')).toBe(15);
    expect(stallMinutesFor('* * * * *')).toBe(15);
  });

  it('日任务 cron（0 3 * * * / 0 4 * * *）→ 26 小时', () => {
    expect(stallMinutesFor('0 3 * * *')).toBe(26 * 60);
    expect(stallMinutesFor('0 4 * * *')).toBe(26 * 60);
  });

  it('小时任务（0 * * * *）按非分钟级 → 26 小时', () => {
    expect(stallMinutesFor('0 * * * *')).toBe(26 * 60);
  });

  it('空/脏 cron 容错', () => {
    expect(stallMinutesFor('')).toBe(26 * 60);
    expect(stallMinutesFor('   ')).toBe(26 * 60);
  });
});

describe('cronActiveHours 小时字段解析', () => {
  it('*/5 8-23 * * * → 8..23（分钟级 */5 不影响小时）', () => {
    expect([...cronActiveHours('*/5 8-23 * * *')].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => 8 + i), // 8..23
    );
  });

  it('0 3 * * * → [3]（日任务单值小时）', () => {
    expect([...cronActiveHours('0 3 * * *')]).toEqual([3]);
  });

  it('* * * * * → 全天 [0..23]', () => {
    expect(cronActiveHours('* * * * *').size).toBe(24);
    expect(cronActiveHours('* * * * *').has(0)).toBe(true);
    expect(cronActiveHours('* * * * *').has(23)).toBe(true);
  });

  it('逗号列表 / 区间+步长', () => {
    expect([...cronActiveHours('0 1,3,5 * * *')].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect([...cronActiveHours('0 8-23/2 * * *')].sort((a, b) => a - b)).toEqual([
      8, 10, 12, 14, 16, 18, 20, 22,
    ]);
  });

  it('空/脏 cron → 全天（保守不误报停采窗口外）', () => {
    expect(cronActiveHours('').size).toBe(24);
    expect(cronActiveHours('   ').size).toBe(24);
    expect(cronActiveHours('*/5').size).toBe(24); // 仅一个字段，无小时字段
  });
});

describe('collectStallEvaluator 全量扫描', () => {
  it('分钟级任务陈旧（>15 分钟）→ firing，elapsed/threshold/reason 正确', async () => {
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:40:00Z' })]; // 20 分钟前
    const hits = await collectStallEvaluator(makeDeps(tasks));

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      firing: true,
      taskId: 'task-1',
      elapsedMinutes: 20,
      thresholdMinutes: 15,
    });
    expect(hits[0].reason).toContain('采集已停止 20 分钟');
    expect(hits[0].reason).toContain('阈值 15 分钟');
  });

  it('分钟级任务新鲜（<=15 分钟）→ 不 firing', async () => {
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:50:00Z' })]; // 10 分钟前
    const hits = await collectStallEvaluator(makeDeps(tasks));
    expect(hits).toHaveLength(0);
  });

  it('禁用任务陈旧 → 跳过（不 firing）', async () => {
    const tasks = [makeTask({ enabled: false, last_run_at: '2026-08-05T10:00:00Z' })]; // 2h 前
    const hits = await collectStallEvaluator(makeDeps(tasks));
    expect(hits).toHaveLength(0);
  });

  it('从未运行（last_run_at 为空）→ 跳过（不 firing）', async () => {
    const tasks = [makeTask({ last_run_at: null })];
    const hits = await collectStallEvaluator(makeDeps(tasks));
    expect(hits).toHaveLength(0);
  });

  it('夜间（0-7 点）停采窗口外 → 不 firing + reason 标「停采窗口外」', async () => {
    // `*/5 8-23` 2 小时前，远超 15 分钟阈值，但当前中国 2 点不在活跃窗口 → 正常停采
    const tasks = [makeTask({ schedule_cron: '*/5 8-23 * * *', last_run_at: '2026-08-05T10:00:00Z' })];
    const hits = await collectStallEvaluator(makeDeps(tasks), {}, HOUR_NIGHT);

    expect(hits).toHaveLength(1);
    expect(hits[0].firing).toBe(false);
    expect(hits[0].reason).toContain('停采窗口外');
    expect(hits[0].reason).toContain('当前 2 点');
    expect(hits[0].reason).toContain('活跃 8-23 点');
  });

  it('活跃窗口内陈旧（>阈值）→ firing', async () => {
    const tasks = [makeTask({ schedule_cron: '*/5 8-23 * * *', last_run_at: '2026-08-05T11:40:00Z' })]; // 20 分钟前
    const hits = await collectStallEvaluator(makeDeps(tasks), {}, HOUR_ACTIVE);
    expect(hits).toHaveLength(1);
    expect(hits[0].firing).toBe(true);
  });

  it('日任务窗口外（非活跃小时）陈旧 → 不 firing（不误报）', async () => {
    // `0 3 * * *` 30 小时前、远超 26h，但当前中国 20 点不在活跃小时 [3] → 正常停采
    const tasks = [makeTask({ schedule_cron: '0 3 * * *', last_run_at: '2026-08-04T06:00:00Z' })];
    const hits = await collectStallEvaluator(makeDeps(tasks), {}, HOUR_ACTIVE);

    expect(hits).toHaveLength(1);
    expect(hits[0].firing).toBe(false);
    expect(hits[0].reason).toContain('停采窗口外');
  });

  it('日任务 2 小时未跑（未超 26h）→ 不 firing（活跃小时内）', async () => {
    const tasks = [makeTask({ schedule_cron: '0 3 * * *', last_run_at: '2026-08-05T10:00:00Z' })]; // 2h 前
    const hits = await collectStallEvaluator(makeDeps(tasks), {}, HOUR_DAILY_RUN);
    expect(hits).toHaveLength(0);
  });

  it('日任务 30 小时未跑（超 26h）→ firing（活跃小时内）', async () => {
    const tasks = [makeTask({ schedule_cron: '0 3 * * *', last_run_at: '2026-08-04T06:00:00Z' })]; // 30h 前
    const hits = await collectStallEvaluator(makeDeps(tasks), {}, HOUR_DAILY_RUN);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ firing: true, elapsedMinutes: 30 * 60, thresholdMinutes: 26 * 60 });
  });

  it('多个任务混合：只返回陈旧项', async () => {
    const tasks = [
      makeTask({ id: 't-stale', last_run_at: '2026-08-05T11:00:00Z' }), // 60 分钟前 → 陈旧
      makeTask({ id: 't-fresh', last_run_at: '2026-08-05T11:55:00Z' }), // 5 分钟前 → 新鲜
      makeTask({ id: 't-disabled', enabled: false, last_run_at: '2026-08-05T09:00:00Z' }), // 禁用
    ];
    const hits = await collectStallEvaluator(makeDeps(tasks));
    expect(hits.filter((h) => h.firing).map((h) => h.taskId)).toEqual(['t-stale']);
  });
});

describe('evalCollectStall engine 适配（per-rule）', () => {
  it('rule 命中陈旧任务 → firing true + alert_key collect_stall:<task_id>', async () => {
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:40:00Z' })]; // 20 分钟前
    const r = await evalCollectStall(makeRule('task-1'), makeDeps(tasks));

    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('collect_stall:task-1');
    expect(r.context).toMatchObject({
      task_id: 'task-1',
      elapsed_minutes: 20,
      threshold_minutes: 15,
      last_run_at: '2026-08-05T11:40:00Z',
    });
    expect(r.context.reason).toContain('采集已停止 20 分钟');
  });

  it('rule 命中新鲜任务 → firing false', async () => {
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:50:00Z' })]; // 10 分钟前
    const r = await evalCollectStall(makeRule('task-1'), makeDeps(tasks));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('collect_stall:task-1');
  });

  it('rule 命中停采窗口外任务（夜间）→ firing false + reason 标「停采窗口外」', async () => {
    // `*/5 8-23` 2 小时前，但 deps.now 为中国 02:00（NIGHT_NOW）→ 窗口外正常停采
    const tasks = [makeTask({ schedule_cron: '*/5 8-23 * * *', last_run_at: '2026-08-05T10:00:00Z' })];
    const r = await evalCollectStall(makeRule('task-1'), makeDeps(tasks, NIGHT_NOW));

    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('collect_stall:task-1');
    expect(r.context.reason).toContain('停采窗口外');
    expect(r.context.task_id).toBe('task-1');
  });

  it('rule.target 缺省 → firing false + 明确 reason', async () => {
    const r = await evalCollectStall(makeRule(''), makeDeps([makeTask()]));
    expect(r.firing).toBe(false);
    expect(r.context.reason).toBe('rule 缺 target(task_id)');
  });

  it('rule 命中禁用任务 → firing false', async () => {
    const tasks = [makeTask({ enabled: false, last_run_at: '2026-08-05T10:00:00Z' })];
    const r = await evalCollectStall(makeRule('task-1'), makeDeps(tasks));
    expect(r.firing).toBe(false);
  });

  it('rule.threshold.stall_minutes 覆盖默认阈值（放宽）→ 不 firing', async () => {
    // 20 分钟前、分钟级任务：默认阈值 15 → 会 firing；覆盖为 60 → 不 firing
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:40:00Z' })];
    const r = await evalCollectStall(makeRule('task-1', { stall_minutes: 60 }), makeDeps(tasks));
    expect(r.firing).toBe(false);
  });

  it('rule.threshold.stall_minutes 覆盖默认阈值（收紧）→ firing + threshold_minutes 用覆盖值', async () => {
    // 10 分钟前、分钟级任务：默认阈值 15 → 不 firing；覆盖为 5 → firing
    const tasks = [makeTask({ last_run_at: '2026-08-05T11:50:00Z' })];
    const r = await evalCollectStall(makeRule('task-1', { stall_minutes: 5 }), makeDeps(tasks));
    expect(r.firing).toBe(true);
    expect(r.context.threshold_minutes).toBe(5);
    expect(r.context.elapsed_minutes).toBe(10);
  });
});
