// web/lib/sync/__tests__/casdoor-client.test.ts
// T6/T4 真机发现的断链修复（2026-08-17）：
//   ① provision add-user 假成功（HTTP 200 + body{status:'error'} 静默 → 标 synced_at 丢户）
//   ② disableUser 裸 update-user 按 token 身份找用户 → 从未真正禁用（sink③ 断链）
// 真机验证的可用形态：update-user 必须 ?id=owner/name + 全量对象 merge。
// 2026-08-18：assignRoles 已随薄同步收缩删除（角色归属全量 manual，Casdoor UI 单写者）。

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.CASDOOR_API_URL = 'http://casdoor-test';
process.env.CASDOOR_CLIENT_ID = 'cid';
process.env.CASDOOR_CLIENT_SECRET = 'sec';

const { provisionUser, disableUser } = await import('../casdoor-client');

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

