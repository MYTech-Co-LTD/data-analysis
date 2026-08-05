import { describe, it, expect } from 'vitest';
import { evalServiceDown } from '../service-down';
import type { MonitorRule, EvalDeps, ProbeOutcome } from '../../types';

const rule = (target: string): MonitorRule => ({
  id: 1, name: `svc-${target}`, check_type: 'service_down', target, threshold: {},
  severity: 'critical', touser: '@default', template: '{svc} 不可达({detail})',
  suppress_window_seconds: 1800, enabled: true,
});

const deps = (ok: boolean, extra: Partial<ProbeOutcome> = {}): EvalDeps => ({
  now: new Date('2026-07-08T10:00:00Z'),
  probe: async () => ({ ok, latencyMs: 5, status: ok ? 200 : undefined, ...extra } as ProbeOutcome),
  getCredentialToken: async () => null,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
});

describe('evalServiceDown', () => {
  it('探活成功 → 不 firing', async () => {
    const r = await evalServiceDown(rule('duckdb'), deps(true));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('svc:duckdb');
  });

  it('探活失败 → firing + context', async () => {
    const r = await evalServiceDown(rule('duckdb'), deps(false, { error: 'ECONNREFUSED' }));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('svc:duckdb');
    expect(r.context).toMatchObject({ svc: 'duckdb', detail: 'ECONNREFUSED' });
  });

  it('未知服务名 → firing，context 标 unknown', async () => {
    const r = await evalServiceDown(rule('mars'), deps(false));
    expect(r.firing).toBe(true);
    expect(r.context.svc).toBe('mars');
  });
});
