// web/lib/sync/__tests__/casdoor-client.test.ts
// T6/T4 真机发现的三处断链修复（2026-08-17）：
//   ① provision add-user 假成功（HTTP 200 + body{status:'error'} 静默 → 标 synced_at 丢户）
//   ② disableUser 裸 update-user 按 token 身份找用户 → 从未真正禁用（sink③ 断链）
//   ③ assignRoles 把 get-user 外壳 {status,data} 当 user → roles 恒空
// 真机验证的可用形态：update-user 必须 ?id=owner/name + 全量对象 merge。

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.CASDOOR_API_URL = 'http://casdoor-test';
process.env.CASDOOR_CLIENT_ID = 'cid';
process.env.CASDOOR_CLIENT_SECRET = 'sec';

const { provisionUser, disableUser, assignRoles } = await import('../casdoor-client');

const mkResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockFetchSeq(responses: Array<(url: string, init?: RequestInit) => Response>) {
  let i = 0;
  global.fetch = vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('access_token')) return mkResp(200, { access_token: 'tok', expires_in: 3600 });
    const fn = responses[Math.min(i++, responses.length - 1)];
    return fn(url, init);
  }) as unknown as typeof fetch;
}

const USER = { owner: 'shanhai', name: 'U1', displayName: '张三', roles: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('provisionUser — body 级判红（HTTP 200 + status:error 不再假成功）', () => {
  it('add-user body error → ok:false（thin-sync 将入 outbox，不再静默标 synced_at）', async () => {
    mockFetchSeq([
      () => mkResp(200, { status: 'error', msg: 'The application: shanhai-data doesn\'t exist' }),
      () => mkResp(200, { status: 'error', msg: 'app rejected' }),
    ]);
    const r = await provisionUser({ name: 'NewUser', displayName: '新' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('casdoor_body_error');
  });

  it('已存在（get-user data 非空）→ 幂等跳过', async () => {
    mockFetchSeq([() => mkResp(200, { status: 'ok', data: USER })]);
    const r = await provisionUser({ name: 'U1', displayName: '张三' });
    expect(r).toEqual({ ok: true, created: false });
  });

  it('不存在 + add-user ok → created', async () => {
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: null }),           // get-user 不存在
      () => mkResp(200, { status: 'ok', data: 'Affected' }),      // add-user
    ]);
    const r = await provisionUser({ name: 'U1', displayName: '张三' });
    expect(r).toEqual({ ok: true, created: true });
  });
});

describe('disableUser — sink③ 唯可用形态（get-user 解包 merge + update-user?id=）', () => {
  it('成功路径：get-user → merge isForbidden → update-user?id=', async () => {
    const calls: string[] = [];
    mockFetchSeq([
      (u) => { calls.push(u); return mkResp(200, { status: 'ok', data: { ...USER } }); },
      (u, init) => {
        calls.push(u);
        expect(u).toContain('/api/update-user?id=shanhai/U1');
        expect(String(init?.body)).toContain('"isForbidden":true');
        return mkResp(200, { status: 'ok', data: 'Affected' });
      },
    ]);
    const r = await disableUser('U1');
    expect(r.ok).toBe(true);
    expect(calls[0]).toContain('/api/get-user?id=shanhai/U1');
  });

  it('用户不存在 → 显式失败（入 outbox 观察，不再假成功）', async () => {
    mockFetchSeq([() => mkResp(200, { status: 'ok', data: null })]);
    const r = await disableUser('Ghost');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('user_not_found_in_casdoor');
  });

  it('update-user body error（旧断链形态）→ ok:false', async () => {
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: { ...USER } }),
      () => mkResp(200, { status: 'error', msg: 'The ID is immutable.' }),
    ]);
    const r = await disableUser('U1');
    expect(r.ok).toBe(false);
  });
});

describe('assignRoles — 角色绑定在 Role.Users 侧（update-role 全量写，源码 v3.150.0 机制）', () => {
  // 构造 get-roles 返回（当前 U1 在 r1，不在 r2）
  const rolesData = () => [
    { owner: 'shanhai', name: 'r1', users: ['shanhai/U1'] },
    { owner: 'shanhai', name: 'r2', users: [] },
  ];

  it('已在目标角色（Role.Users 含 U1）→ 幂等无写', async () => {
    const writes = 0;
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: rolesData() }),       // get-roles
    ]);
    const r = await assignRoles('U1', ['r1']);
    expect(r).toEqual({ ok: true, changed: false });
    expect(writes).toBe(0);
  });

  it('目标角色缺 U1 → update-role 全量 merge Users（带 memberId）', async () => {
    const calls: string[] = [];
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: rolesData() }),               // get-roles（U1 在 r1）
      () => mkResp(200, { status: 'ok', data: { owner: 'shanhai', name: 'r2', users: [] } }),  // get-role r2
      (u, init) => {
        calls.push(u);
        expect(u).toContain('/api/update-role?id=shanhai%2Fr2');
        const body = JSON.parse(String(init?.body));
        expect(body.users).toEqual(['shanhai/U1']);
        return mkResp(200, { status: 'ok', data: 'Affected' });
      },
    ]);
    const r = await assignRoles('U1', ['r1', 'r2']);
    expect(r).toEqual({ ok: true, changed: true });
    expect(calls[0]).toContain('/api/update-role');
  });

  it('移出非目标角色 → update-role 从 Users 移除 memberId', async () => {
    const calls: string[] = [];
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: rolesData() }),               // get-roles（U1 在 r1）
      () => mkResp(200, { status: 'ok', data: { owner: 'shanhai', name: 'r2', users: [] } }),  // get-role r2（目标，空）
      (u) => {
        calls.push(String(u));
        return mkResp(200, { status: 'ok', data: 'Affected' });
      },  // update-role r2（加 U1）
      () => mkResp(200, { status: 'ok', data: { owner: 'shanhai', name: 'r1', users: ['shanhai/U1', 'shanhai/X'] } }),  // get-role r1
      (u, init) => {
        calls.push(String(u));
        expect(String(u)).toContain('/api/update-role?id=shanhai%2Fr1');
        const body = JSON.parse(String(init?.body));
        expect(body.users).toEqual(['shanhai/X']);
        return mkResp(200, { status: 'ok', data: 'Affected' });
      },
    ]);
    const r = await assignRoles('U1', ['r2']);
    expect(r).toEqual({ ok: true, changed: true });
    expect(calls[0]).toContain('/api/update-role?id=shanhai%2Fr2');
  });

  it('update-role body error → ok:false（入 outbox 重试，不再假成功）', async () => {
    mockFetchSeq([
      () => mkResp(200, { status: 'ok', data: rolesData() }),
      () => mkResp(200, { status: 'ok', data: { owner: 'shanhai', name: 'r2', users: [] } }),
      () => mkResp(200, { status: 'error', msg: 'Forbidden characters' }),
    ]);
    const r = await assignRoles('U1', ['r1', 'r2']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('r2');
  });
});
