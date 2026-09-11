import { describe, it, expect, vi } from 'vitest';
import { evalDataFreshness } from '../data-freshness';
import type { MonitorRule, EvalDeps } from '../../types';

const GLOB = 's3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet';

const rule = (target: string, lookback = 1): MonitorRule => ({
  id: 1,
  name: `补货到达·${target}`,
  check_type: 'data_freshness',
  target,
  threshold: { dataset: 'replenishment_detail', glob_template: GLOB, lookback_days: lookback },
  severity: 'high',
  touser: null,
  template: '缺 {expect_date}',
  suppress_window_seconds: 1800,
  enabled: true,
});

// now = 2026-09-11 10:00 UTC → 中国时间 2026-09-11 18:00 → 昨日(中国) = 2026-09-10
const deps = (rows: Array<{ d: string }>, throwErr?: string): EvalDeps => ({
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

describe('evalDataFreshness', () => {
  it('昨日分区存在 → 不 firing', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10' }, { d: '2026-09-09' }]));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('data_freshness:replenishment_detail:3120');
  });

  it('昨日分区缺失 → firing + context', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([{ d: '2026-09-05' }, { d: '2026-09-04' }]));
    expect(r.firing).toBe(true);
    expect(r.context).toMatchObject({
      dataset: 'replenishment_detail',
      account: '3120',
      expect_date: '2026-09-10',
      have_latest: '2026-09-05',
    });
    // ★ 必须钉住：模板是 `🔴 [{severity}] …`，而 renderTemplate 只在 `key in context` 时替换。
    //   少了这条断言，删掉 evaluator 里的 severity 注入**全部用例仍绿**，而告警正文会显示字面量 `[{severity}]`。
    expect(r.context.severity).toBe('high');
  });

  it('一个分区都没有 → firing，have_latest=none', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:64188'), deps([]));
    expect(r.firing).toBe(true);
    expect(r.context.have_latest).toBe('none');
  });

  it('探测异常 → 不 firing（不误报；duckdb 本体故障由 service_down 桶负责）且必须留下日志', async () => {
    // ★ 只断言 firing===false 是不够的：删掉 evaluator 里的 console.error，该用例仍绿，
    //   而「探测坏了」会变成无痕静默——正是本任务要消灭的失败模式。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([], 'ECONNREFUSED'));
      expect(r.firing).toBe(false);
      expect(r.context).toMatchObject({ reason: 'probe_error' });
      expect(spy).toHaveBeenCalled(); // 删掉 evaluator 的 console.error → 这条变红
    } finally {
      spy.mockRestore();
    }
  });

  it('glob 无匹配文件（No files found）→ firing（分区确实不存在，不能静默）', async () => {
    // ★ 这是本守护最该响的场景：DuckDB 对「glob 一个文件都没匹配到」抛的是异常而非空集。
    //   若把它当 probe_error 归到「不报」，唯一必须响的场景就静默了——正是要消灭的失败模式。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await evalDataFreshness(
        rule('replenishment_detail:3120'),
        deps([], 'IO Error: No files found that match the pattern "s3://lemeng-datasource/duckle/lemeng/replenishment_detail/3120/*/all.parquet"'),
      );
      expect(r.firing).toBe(true);
      expect(r.context.have_latest).toBe('none');
      expect(r.context.expect_date).toBe('2026-09-10');
      expect(r.context.severity).toBe('high');
      expect(warn).toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled(); // 不是故障，不该报 error
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  it('target 格式非法 → 不 firing（不瞎报）', async () => {
    const r = await evalDataFreshness(rule('bogus'), deps([]));
    expect(r.firing).toBe(false);
  });

  it('lookback_days=2 时看前天', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120', 2), deps([{ d: '2026-09-10' }]));
    expect(r.firing).toBe(true);
    expect(r.context.expect_date).toBe('2026-09-09');
  });

  it('账套被代入 glob（不同账套各查各的）', async () => {
    let seen = '';
    const d = deps([]);
    d.duckdbQuery = async (sql: string) => {
      seen = sql;
      return [];
    };
    await evalDataFreshness(rule('replenishment_detail:64188'), d);
    expect(seen).toContain('replenishment_detail/64188/');
    expect(seen).not.toContain('{account}');
  });
});
