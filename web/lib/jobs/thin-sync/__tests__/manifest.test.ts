// web/lib/jobs/thin-sync/__tests__/manifest.test.ts
// 离职四 sink（188）：actionDisable 成功路径——Casdoor disable + casdoor_writer 标记 +
// token_blacklist 按 user_id 写入（幂等：已有行不重复写）。失败路径 → outbox。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const REAL_FETCH = global.fetch;

// manifest.ts 顶层读 env（POSTGREST_URL 等）——先置好再 import
process.env.POSTGREST_URL = 'http://postgrest-test:3000';
process.env.INSFORGE_API_KEY = 'test-key';

// mock casdoor-client（disableUser / provisionUser / assignRoles）
vi.mock('../../../sync/casdoor-client', () => ({
  disableUser: vi.fn(async () => ({ ok: true })),
  provisionUser: vi.fn(async () => ({ ok: true })),
  assignRoles: vi.fn(async () => ({ ok: true })),
}));

import { thinSyncManifest } from '../manifest';

interface CallLog { method: string; url: string; body?: string }

function lastMock() {
  // thin-sync run 会先 drain outbox + 三动作——本测试只关注 disable 分支的调用
  return (global.fetch as unknown as { mock?: { calls: Array<[string, RequestInit]> } }).mock?.calls ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
});

function setupFetch(users: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const calls: CallLog[] = [];
  global.fetch = vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('org_users') && url.includes('casdoor_writer=neq.disabled')) {
      return new Response(JSON.stringify(users), { status: 200 });
    }
    // outbox 相关（drain / enqueue 查询）返回空
    if (url.includes('sync_outbox')) return new Response('[]', { status: 200 });
    // auto 角色写入的 org_users 查询（is_active=eq.true）返回空
    if (url.includes('org_users')) return new Response('[]', { status: 200 });
    // provision 查询返回空
    if (url.includes('casdoor_synced_at')) return new Response('[]', { status: 200 });
    // token_blacklist 查询（幂等预查）
    if (url.includes('token_blacklist') && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify(extra.blacklistRows ?? []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
  (global.fetch as unknown as { __calls: CallLog[] }).__calls = calls;
  return calls;
}

describe('thin-sync actionDisable — 离职四 sink', () => {
  it('disable 成功 → Casdoor 禁用 + casdoor_writer 标记 + blacklist 按 user_id 写入', async () => {
    const calls = setupFetch([{ wecom_id: 'TestLiZhi001', name: '测试离职用户' }]);
    await thinSyncManifest.run!({} as never);
    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('org_users') && c.body?.includes('"disabled"'));
    expect(patch).toBeTruthy();
    const blPost = calls.find(c => c.method === 'POST' && c.url.includes('token_blacklist'));
    expect(blPost).toBeTruthy();
    const payload = JSON.parse(blPost!.body!);
    expect(payload.user_id).toBe('TestLiZhi001');
    expect(payload.token_hash).toBe('sub:TestLiZhi001');
    expect(payload.reason).toBe('offboard');
    // expires_at = +7d JWT 窗口（≈7 天后的 ISO）
    expect(new Date(payload.expires_at).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86400_000);
  });

  it('blacklist 幂等：已有 user_id 行不重复写', async () => {
    const calls = setupFetch(
      [{ wecom_id: 'TestLiZhi001', name: '测试离职用户' }],
      { blacklistRows: [{ id: 'existing' }] },
    );
    await thinSyncManifest.run!({} as never);
    const blPost = calls.find(c => c.method === 'POST' && c.url.includes('token_blacklist'));
    expect(blPost).toBeUndefined();
  });
});

import { afterEach } from 'vitest';
afterEach(() => {
  global.fetch = REAL_FETCH;
});
