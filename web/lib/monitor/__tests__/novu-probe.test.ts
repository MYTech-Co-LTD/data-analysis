import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evalNovuProbe, NOVU_HEALTH_PATH } from '../evaluators/novu-probe';
import type { MonitorRule, EvalDeps, ProbeOutcome } from '../types';

const rule = (): MonitorRule => ({
  id: 1, name: 'svc-novu', check_type: 'novu_health', target: 'novu', threshold: {},
  severity: 'critical', touser: '@default', template: '{svc} 不可达({detail})',
  suppress_window_seconds: 1800, enabled: true,
});

let probed: Array<{ url: string }> = [];

const deps = (outcome: Partial<ProbeOutcome>): EvalDeps => ({
  now: new Date('2026-08-15T10:00:00Z'),
  probe: async (url) => {
    probed.push({ url });
    return { ok: true, latencyMs: 12, status: 200, ...outcome } as ProbeOutcome;
  },
  getCredentialToken: async () => null,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
});

describe('evalNovuProbe', () => {
  beforeEach(() => {
    probed = [];
    delete process.env.NOVU_API_URL;
  });
  afterEach(() => {
    delete process.env.NOVU_API_URL;
  });

  it('NOVU_API_URL 未配置 → disabled：不 firing、不发起探活', async () => {
    const r = await evalNovuProbe(rule(), deps({}));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('svc:novu');
    expect(r.context.disabled).toBe(true);
    expect(probed).toHaveLength(0);
  });

  it('配置 + 健康端点 200 → 不 firing，latency 透传', async () => {
    process.env.NOVU_API_URL = 'http://127.0.0.1:3000';
    const r = await evalNovuProbe(rule(), deps({ ok: true, status: 200, latencyMs: 45 }));
    expect(r.firing).toBe(false);
    expect(r.context.disabled).toBeUndefined();
    expect(r.context.latency_ms).toBe(45);
    expect(probed).toEqual([{ url: `http://127.0.0.1:3000${NOVU_HEALTH_PATH}` }]);
  });

  it('URL 带尾斜杠 → 拼接不产生双斜杠', async () => {
    process.env.NOVU_API_URL = 'https://novu.internal.shanhaiyiguo.com/';
    await evalNovuProbe(rule(), deps({}));
    expect(probed[0].url).toBe(`https://novu.internal.shanhaiyiguo.com${NOVU_HEALTH_PATH}`);
  });

  it('网络不可达（error）→ firing，detail=error 文案', async () => {
    process.env.NOVU_API_URL = 'http://127.0.0.1:3000';
    const r = await evalNovuProbe(rule(), deps({ ok: false, status: undefined, error: 'connect ECONNREFUSED' }));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('svc:novu');
    expect(r.context.svc).toBe('novu');
    expect(r.context.detail).toBe('connect ECONNREFUSED');
  });

  it('非 2xx（503）→ firing，detail=status 503', async () => {
    process.env.NOVU_API_URL = 'http://127.0.0.1:3000';
    const r = await evalNovuProbe(rule(), deps({ ok: false, status: 503 }));
    expect(r.firing).toBe(true);
    expect(r.context.detail).toBe('status 503');
  });
});
