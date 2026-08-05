import { describe, it, expect } from 'vitest';
import { evalTokenExpire } from '../token-expire';
import type { MonitorRule, EvalDeps } from '../../types';

const now = new Date('2026-07-08T10:00:00Z'); // epoch ms = 1751971200000

// 造一个 exp 在 now 之后 N 小时的 token
const tokenWithExp = (expSec: number) => {
  const payload = Buffer.from(JSON.stringify({ company_id: 3120, exp: expSec })).toString('base64url');
  return `h.${payload}.s`;
};

const rule = (beforeHours: number, sourceId: string): MonitorRule => ({
  id: 1, name: 'token', check_type: 'token_expire', target: sourceId, threshold: { before_hours: beforeHours },
  severity: 'critical', touser: '@default', template: '乐檬-{brand} token 剩 {remain_hours}h',
  suppress_window_seconds: 3600, enabled: true,
});

// source_id 是 UUID（data_sources.id）
const SRC = 'a0000000-0000-0000-0000-000000000001';

const deps = (token: string | null): EvalDeps => ({
  now,
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => token,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
});

describe('evalTokenExpire', () => {
  it('剩 2h，阈值 24h → firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 2 * 3600;
    const r = await evalTokenExpire(rule(24, SRC), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe(`token:${SRC}`);
    expect(r.context.remain_hours).toBeCloseTo(2, 0);
    expect(r.context.brand).toBe(3120);
  });

  it('剩 48h，阈值 24h → 不 firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 48 * 3600;
    const r = await evalTokenExpire(rule(24, SRC), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(false);
  });

  // token 缺失/不可用属于异常：必须 firing，否则引擎会把此前 active 的告警当"恢复"自动 resolve，
  // 发误导性 ✅ 已恢复（曾发生：3120 credential 被清成 {} → 假恢复致盲）。
  it('无凭证 → firing（token 缺失），带可读 message，不静默恢复', async () => {
    const r = await evalTokenExpire(rule(24, SRC), deps(null));
    expect(r.firing).toBe(true);
    expect(r.context.missing).toBe(true);
    expect(r.message).toBeTruthy();
    expect(r.message).toMatch(/缺失/);
  });

  it('token 无法解码 exp → firing（不可用），带可读 message', async () => {
    const r = await evalTokenExpire(rule(24, SRC), deps('not-a-jwt'));
    expect(r.firing).toBe(true);
    expect(r.context.undecodable).toBe(true);
    expect(r.message).toMatch(/无法解析|无效/);
  });
});
