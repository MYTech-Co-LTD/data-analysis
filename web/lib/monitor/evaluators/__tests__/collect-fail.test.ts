import { describe, it, expect } from 'vitest';
import { evalCollectFail } from '../collect-fail';
import type { MonitorRule, EvalDeps } from '../../types';

const now = new Date('2026-07-10T05:00:00Z');
const TASK = 'a0000000-0000-0000-0000-000000000002';

const rule = (consecutive: number, window = 5): MonitorRule => ({
  id: 1, name: '采集失败·乐檬-3120-商品档案采集', check_type: 'collect_fail', target: TASK,
  threshold: { consecutive, window }, severity: 'high', touser: null,
  template: '连续 {consecutive_count} 次失败：{last_error}', suppress_window_seconds: 1800, enabled: true,
});

const deps = (logs: Array<{ status: string; error_message?: string }>): EvalDeps => ({
  now,
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => null,
  getCollectLogs: async () => logs.map(l => ({ status: l.status, started_at: '', error_message: l.error_message ?? null })),
  getCollectTasks: async () => [],
});

describe('evalCollectFail', () => {
  it('最近 1 次失败 + 阈值 1 → firing', async () => {
    const r = await evalCollectFail(rule(1), deps([{ status: 'failed', error_message: '校验未通过' }]));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe(`collect:${TASK}`);
    expect(r.context.consecutive_count).toBe(1);
    expect(r.context.last_error).toBe('校验未通过');
  });

  it('失败后已成功（不连续）→ 不 firing', async () => {
    const r = await evalCollectFail(rule(1), deps([{ status: 'success' }, { status: 'failed', error_message: 'x' }]));
    expect(r.firing).toBe(false);
    expect(r.context.consecutive_count).toBe(0);
  });

  it('连续 2 次失败 + 阈值 3 → 不 firing', async () => {
    const r = await evalCollectFail(rule(3), deps([{ status: 'failed' }, { status: 'failed' }, { status: 'success' }]));
    expect(r.firing).toBe(false);
    expect(r.context.consecutive_count).toBe(2);
  });

  it('连续 3 次失败 + 阈值 3 → firing', async () => {
    const r = await evalCollectFail(rule(3), deps([{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }]));
    expect(r.firing).toBe(true);
    expect(r.context.consecutive_count).toBe(3);
  });

  it('partial 也计为失败', async () => {
    const r = await evalCollectFail(rule(1), deps([{ status: 'partial' }]));
    expect(r.firing).toBe(true);
  });

  it('无采集日志 → 不 firing', async () => {
    const r = await evalCollectFail(rule(1), deps([]));
    expect(r.firing).toBe(false);
  });

  it('rule 缺 target → 不 firing', async () => {
    const r = await evalCollectFail({ ...rule(1), target: '' }, deps([{ status: 'failed' }]));
    expect(r.firing).toBe(false);
  });
});
