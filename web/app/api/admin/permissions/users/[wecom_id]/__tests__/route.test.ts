// web/app/api/admin/permissions/users/[wecom_id]/__tests__/route.test.ts
// 个人 override 路由：GET 详情 / PUT upsert（全 null → 删行恢复继承）/ DELETE 删行，均落审计；
// 权限表写失败 → 502 且不写审计（F1 回归）；用户不存在 → 404（review #4，防孤儿 override 行）；requireAdmin 403。
// mock 全局 fetch + 带 cookie 的 NextRequest；params 为 Promise（Next 16 async params）。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT, DELETE } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; process.env.BREAKGLASS_ADMINS = 'ZhangDuo'; vi.spyOn(console, 'warn').mockImplementation(() => {}); }); // P0a：admin 门禁切 checkFeaturePerm，测试 token 无 permissions claim → 走 BREAKGLASS 兜底

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';
const CTX = { params: Promise.resolve({ wecom_id: 'ZhangDuo' }) };
const USER_EXISTS = { json: async () => [{ wecom_id: 'ZhangDuo' }] };

function mkReq(method: 'GET' | 'PUT' | 'DELETE', cookie?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/users/ZhangDuo', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  writeAuditMock.mockReset();
});

describe('GET /users/:wecom_id', () => {
  it('返回 user + override（无行 → override null）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ wecom_id: 'ZhangDuo', name: '张朵' }] })
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['9'], brands: null, categories: null, can_see_cost: true, expires_at: null, note: '临时' }] });
    const res = await GET(mkReq('GET', ADMIN_COOKIE), CTX);
    const body = await res.json();
    expect(body.user).toMatchObject({ wecom_id: 'ZhangDuo', name: '张朵' });
    expect(body.override).toMatchObject({ id: 7, branch_nums: ['9'], can_see_cost: true });
  });

  it('403 for illegal actor', async () => {
    const res = await GET(mkReq('GET', 'insforge_access_token=x; wecom_userid=NotAdmin'), CTX);
    expect(res.status).toBe(403);
  });
});

describe('PUT /users/:wecom_id', () => {
  it('有旧行 → PATCH 更新并写 upsert 审计', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)                                                                                                   // user 存在性（review #4）
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                 // PATCH
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['5', '7'], can_see_cost: true, note: '加店' }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.7');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ branch_nums: ['5', '7'], can_see_cost: true, note: '加店' });
    expect(sent.subject_type).toBeUndefined();
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'upsert_data_permission', subjectType: 'user', subjectId: 'ZhangDuo',
      before: expect.objectContaining({ id: 7 }),
    }));
  });

  it('全 null → 删行恢复继承并写 delete 审计', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)                                                                                                   // user 存在性
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                 // DELETE
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: null, brands: null, categories: null, can_see_cost: null }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=in.(7)');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'delete_data_permission', subjectType: 'user', subjectId: 'ZhangDuo', after: null,
    }));
  });

  it('全 null 删行失败 → 502 且不写审计（F1 回归）', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: false, text: async () => 'delete boom' });                                                                                 // DELETE 失败
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: null, brands: null, categories: null, can_see_cost: null }), CTX);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('delete boom');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('无旧行 → POST 新建', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce({ json: async () => [] })   // 读旧（无行）
      .mockResolvedValueOnce({ ok: true });               // POST
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ subject_type: 'user', subject_id: 'ZhangDuo', branch_nums: ['9'], brands: null, categories: null, can_see_cost: null });
  });

  it('用户不存在 → 404，不写任何 override 行（review #4）', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => [] });  // org_users 无此人
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'] }), CTX);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('用户不存在，请先同步通讯录');
    expect(fetchMock.mock.calls.length).toBe(1); // 只做了一个存在性查询
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('403 for illegal actor（F9）', async () => {
    const res = await PUT(mkReq('PUT', 'insforge_access_token=x; wecom_userid=NotAdmin', { branch_nums: ['9'] }), CTX);
    expect(res.status).toBe(403);
  });

  it('非字符串数组 → 400（F6）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: [1, 2] }), CTX);
    expect(res.status).toBe(400);
    const res2 = await PUT(mkReq('PUT', ADMIN_COOKIE, { brands: { '3120': true } }), CTX);
    expect(res2.status).toBe(400);
  });

  it('can_see_cost 类型混淆 → 400（F6）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'], can_see_cost: 'yes' }), CTX);
    expect(res.status).toBe(400);
  });

  it('空数组维 == 未配：全空 → 删行恢复继承（F4）', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                 // DELETE
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: [], brands: [], categories: [], can_see_cost: null }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });

  it('空数组单维 → 视同未配，其余维照写（F4）', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                 // PATCH
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: [], can_see_cost: true }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ branch_nums: null, brands: null, categories: null, can_see_cost: true });
  });
});

describe('DELETE /users/:wecom_id', () => {
  it('删全部 override 行并写 delete 审计', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)                                                                                                   // user 存在性
      .mockResolvedValueOnce({ json: async () => [{ id: 7 }, { id: 8 }] })  // 读旧（2 行）
      .mockResolvedValueOnce({ ok: true });                                   // DELETE id=in.(7,8)
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=in.(7,8)');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'delete_data_permission', subjectType: 'user', subjectId: 'ZhangDuo',
      before: expect.objectContaining({ id: 8 }),
    }));
  });

  it('删行失败 → 502 且不写审计（F1 回归）', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce({ json: async () => [{ id: 7 }] })            // 读旧
      .mockResolvedValueOnce({ ok: false, text: async () => 'del boom' });  // DELETE 失败
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('del boom');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('用户不存在 → 404（review #4）', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => [] });
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect(res.status).toBe(404);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('403 for illegal actor（F9）', async () => {
    const res = await DELETE(mkReq('DELETE', 'insforge_access_token=x; wecom_userid=NotAdmin'), CTX);
    expect(res.status).toBe(403);
  });
});

// W5 写关闭（Task 18 / 迁移 184）：data_permissions DB 级禁写——两层拒绝的错误体都须收敛为
// 409 { error:'frozen', guidance }（REVOKE 层 42501 / 触发器层 P0001），且不写审计。
describe('W5 写关闭 → 409 frozen 契约', () => {
  const OLD_ROW = { json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] };

  it('REVOKE 层错误体（42501 permission denied）→ 409 frozen + 引导，不写审计', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce(OLD_ROW)
      .mockResolvedValueOnce({ ok: false, text: async () => '{"code":"42501","message":"permission denied for table data_permissions"}' });  // PATCH 被 REVOKE
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'] }), CTX);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('frozen');
    expect(body.guidance).toContain('例外');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('触发器层错误体（P0001 frozen）→ 409 frozen（DELETE 路径）', async () => {
    fetchMock
      .mockResolvedValueOnce(USER_EXISTS)
      .mockResolvedValueOnce(OLD_ROW)
      .mockResolvedValueOnce({ ok: false, text: async () => '{"code":"P0001","message":"data_permissions frozen (W5 写关闭, spec 2026-08-16 §5.2): ..."}' });
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('frozen');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});