import { describe, it, expect, vi } from 'vitest';
import { evalDataVolume } from '../data-volume';
import type { MonitorRule, EvalDeps } from '../../types';

const GLOB = 's3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet';

const rule = (target: string, extra: Record<string, unknown> = {}): MonitorRule => ({
  id: 1,
  name: `补货行数异常·${target}`,
  check_type: 'data_volume',
  target,
  threshold: {
    dataset: 'replenishment_detail',
    glob_template: GLOB,
    lookback_days: 1,
    median_window: 7,
    deviation_pct: 50,
    min_samples: 3,
    ...extra,
  },
  severity: 'high',
  touser: null,
  template: '行数 {rows} vs 中位 {median}',
  suppress_window_seconds: 1800,
  enabled: true,
});

// now = 2026-09-11 10:00 UTC → 中国 2026-09-11 → 昨日 = 2026-09-10
const deps = (rows: Array<{ d: string; n: number }>, throwErr?: string): EvalDeps => ({
  now: new Date('2026-09-11T10:00:00Z'),
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => null,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
  duckdbQuery: async () => {
    if (throwErr) throw new Error(throwErr);
    return rows;
  },
});

const WEEK = [
  { d: '2026-09-09', n: 580 },
  { d: '2026-09-08', n: 575 },
  { d: '2026-09-07', n: 520 },
  { d: '2026-09-06', n: 531 },
  { d: '2026-09-05', n: 612 },
];

describe('evalDataVolume', () => {
  it('昨日行数正常 → 不 firing', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 589 }, ...WEEK]));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('data_volume:replenishment_detail:3120');
  });

  it('昨日行数骤降（半截数据）→ firing + context', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 40 }, ...WEEK]));
    expect(r.firing).toBe(true);
    expect(r.context).toMatchObject({ account: '3120', date: '2026-09-10', rows: 40 });
    expect(Number(r.context.deviation_pct)).toBeGreaterThan(50);
    // ★ 承重断言（同 Task 7 的教训）：模板是 `🔴 [{severity}] …`，renderTemplate 只在 `key in context` 时替换。
    //   少了它，删掉 evaluator 的 severity 注入**全部用例仍绿**，而告警正文会显示字面量 `[{severity}]`。
    expect(r.context.severity).toBe('high');
  });

  it('昨日行数暴涨 → firing', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 5000 }, ...WEEK]));
    expect(r.firing).toBe(true);
  });

  it('样本不足（< min_samples）→ 不 firing（冷启动保护）', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 3 }, { d: '2026-09-09', n: 580 }]));
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'insufficient_samples' });
  });

  it('昨日分区不存在 → 不 firing（交由 data_freshness 负责）', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps(WEEK));
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'no_data_for_date' });
  });

  it('中位数为 0 → 不 firing（防除零）', async () => {
    const r = await evalDataVolume(
      rule('replenishment_detail:3120'),
      deps([{ d: '2026-09-10', n: 10 }, { d: '2026-09-09', n: 0 }, { d: '2026-09-08', n: 0 }, { d: '2026-09-07', n: 0 }]),
    );
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'zero_median' });
  });

  it('探测异常 → 不 firing 且必须留下日志', async () => {
    // ★ 只断言 firing===false 不够：删掉 evaluator 的 console.error，该用例仍绿，
    //   而「探测坏了」会变成无痕静默——正是本任务要消灭的失败模式。（同 Task 7 的教训）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([], 'ECONNREFUSED'));
      expect(r.firing).toBe(false);
      expect(r.context).toMatchObject({ reason: 'probe_error' });
      expect(spy).toHaveBeenCalled(); // 删掉 evaluator 的 console.error → 这条变红
    } finally {
      spy.mockRestore();
    }
  });
});
