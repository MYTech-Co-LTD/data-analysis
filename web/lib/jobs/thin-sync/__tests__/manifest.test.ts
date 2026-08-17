// web/lib/jobs/thin-sync/__tests__/manifest.test.ts
// 离职四 sink（188）：actionDisable 成功路径——Casdoor disable + casdoor_writer 标记 +
// token_blacklist 按 user_id 写入（幂等：已有行不重复写）。失败路径 → outbox。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const REAL_FETCH = global.fetch;

// manifest.ts 顶层读 env（POSTGREST_URL 等）——先置好再 import
process.env.POSTGREST_URL = 'http://postgrest-test:3000';
process.env.INSFORGE_API_KEY = 'test-key';

// mock casdoor-client（disableUser / provisionUser / assignRoles / syncUserGroups）
vi.mock('../../../sync/casdoor-client', () => ({
  disableUser: vi.fn(async () => ({ ok: true })),
  provisionUser: vi.fn(async () => ({ ok: true })),
  assignRoles: vi.fn(async () => ({ ok: true })),
  syncUserGroups: vi.fn(async () => ({ ok: true, changed: false })),
  casdoorGroupsFromDepts: (names: string[]) => names.map((n) => `shanhai/${n}`),
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

// ---- 2026-08-17 陈润补挂：provision 传组 + 组对账 ----
import { provisionUser as mockProvision, syncUserGroups as mockSyncGroups } from '../../../sync/casdoor-client';

describe('thin-sync provision — 带部门组建户（2026-08-17 陈润根因修复）', () => {
  it('provisionUser 收到 department_ids 映射出的 groups（运营→shanhai/运营）', async () => {
    const provisionUsers = [{ wecom_id: 'YiBeiMeiShi.', name: '陈润', department_ids: ['63'] }];
    global.fetch = vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('sync_outbox')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=neq.disabled')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=eq.auto')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_synced_at=is.null')) return new Response(JSON.stringify(provisionUsers), { status: 200 });
      if (url.includes('org_departments')) return new Response(JSON.stringify([{ id: '63', name: '运营' }]), { status: 200 });
      if (url.includes('org_users') && init?.method === 'PATCH') return new Response('[]', { status: 200 });
      if (url.includes('org_users')) return new Response('[]', { status: 200 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await thinSyncManifest.run!({} as never);

    expect(mockProvision).toHaveBeenCalledWith({
      name: 'YiBeiMeiShi.',
      displayName: '陈润',
      groups: ['shanhai/运营'],
    });
  });
});

describe('thin-sync 组对账 actionSyncGroups — 存量空组补挂（2026-08-17 陈润自愈）', () => {
  it('active 且有部门用户 → syncUserGroups 补挂期望组', async () => {
    const syncUsers = [{ wecom_id: 'YiBeiMeiShi.', name: '陈润', department_ids: ['63'] }];
    global.fetch = vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('sync_outbox')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=neq.disabled')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=eq.auto')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_synced_at=is.null')) return new Response('[]', { status: 200 });
      if (url.includes('org_departments')) return new Response(JSON.stringify([{ id: '63', name: '运营' }]), { status: 200 });
      if (url.includes('org_users') && init?.method === 'PATCH') return new Response('[]', { status: 200 });
      if (url.includes('org_users')) return new Response(JSON.stringify(syncUsers), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await thinSyncManifest.run!({} as never);

    expect(mockSyncGroups).toHaveBeenCalledWith('YiBeiMeiShi.', ['shanhai/运营']);
  });

  it('无部门用户跳过（department_ids 空不触发 syncUserGroups）', async () => {
    const syncUsers = [{ wecom_id: 'NoDeptUser', name: '无部门', department_ids: [] }];
    global.fetch = vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('sync_outbox')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=neq.disabled')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_writer=eq.auto')) return new Response('[]', { status: 200 });
      if (url.includes('casdoor_synced_at=is.null')) return new Response('[]', { status: 200 });
      if (url.includes('org_departments')) return new Response(JSON.stringify([{ id: '63', name: '运营' }]), { status: 200 });
      if (url.includes('org_users') && init?.method === 'PATCH') return new Response('[]', { status: 200 });
      if (url.includes('org_users')) return new Response(JSON.stringify(syncUsers), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await thinSyncManifest.run!({} as never);

    expect(mockSyncGroups).not.toHaveBeenCalled();
  });
});

import { afterEach } from 'vitest';
afterEach(() => {
  global.fetch = REAL_FETCH;
  vi.clearAllMocks();
});
