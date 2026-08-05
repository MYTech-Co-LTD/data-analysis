import { describe, it, expect, vi, beforeEach } from 'vitest';

// 主通道 notifyWecom 在 web/lib/notify.ts（从 __tests__/ 算是 ../../notify）
vi.mock('../../notify', () => ({ notifyWecom: vi.fn().mockResolvedValue(undefined) }));
// 兜底通道在 web/lib/monitor/notify-direct.ts（从 __tests__/ 算是 ../notify-direct）
vi.mock('../notify-direct', () => ({ notifyWecomDirect: vi.fn().mockResolvedValue(undefined) }));

import { runScan } from '../engine';
import { MemoryStore } from '../store';
import { EVALUATORS } from '../evaluators';
import type { MonitorRule, EvalDeps, Evaluator } from '../types';

const baseRule = (over: Partial<MonitorRule> = {}): MonitorRule => ({
  id: 1, name: 'r', check_type: 'service_down', target: 'duckdb', threshold: {},
  severity: 'high', touser: '@default', template: '{svc} down', suppress_window_seconds: 1800, enabled: true, ...over,
});

const fakeDeps = (): EvalDeps => ({ now: new Date('2026-07-08T10:00:00Z'), probe: async () => ({ ok: false, latencyMs: 1, error: 'x' }), getCredentialToken: async () => null, getCollectLogs: async () => [], getCollectTasks: async () => [] });

describe('runScan', () => {
  it('firing → 写 active + 发通知', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    notify.mockClear();

    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);

    const a = await store.getActiveAlert('svc:duckdb');
    expect(a?.status).toBe('active');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('suppress 窗口内不重复发（但 occurrence_count 仍 ++）', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);
    notify.mockClear();
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS); // 立刻第二轮

    const a = await store.getActiveAlert('svc:duckdb');
    expect(a?.occurrence_count).toBe(2);
    expect(notify).not.toHaveBeenCalled(); // 窗口内不发
  });

  it('firing 转 false → resolve + 发恢复通知', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const notify = (await import('../../notify')).notifyWecom as any;
    // 第一轮 firing
    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);
    notify.mockClear();
    // 第二轮不 firing（probe ok）
    const okDeps = { ...fakeDeps(), probe: async () => ({ ok: true, latencyMs: 1 }) };
    await runScan(store, ['service_down'], okDeps, EVALUATORS);

    expect(await store.getActiveAlert('svc:duckdb')).toBeNull();
    const [title] = notify.mock.calls[0];
    expect(title).toContain('✅');
  });

  it('svc:insforge firing → 额外走兜底通道 notifyWecomDirect', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule({ id: 2, name: 'svc-insforge', target: 'insforge' })]);
    const direct = (await import('../notify-direct')).notifyWecomDirect as any;
    direct.mockClear();

    await runScan(store, ['service_down'], fakeDeps(), EVALUATORS);

    expect(direct).toHaveBeenCalledTimes(1);
  });

  it('evaluator 抛错 → 不拖垮扫描，记 evaluator_error', async () => {
    const store = new MemoryStore();
    store._seedRules([baseRule()]);
    const throwingEval: Evaluator = async () => { throw new Error('boom'); };
    const throwingRegistry = { service_down: throwingEval } as any;

    await expect(runScan(store, ['service_down'], fakeDeps(), throwingRegistry)).resolves.not.toThrow();
    // console.error 记录即可；不写表（避免 evaluator 错误污染告警流）
  });
});
