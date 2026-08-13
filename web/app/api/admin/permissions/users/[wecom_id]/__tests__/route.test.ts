// web/app/api/admin/permissions/users/[wecom_id]/__tests__/route.test.ts
// 个人 override 路由：GET 详情 / PUT upsert（全 null → 删行恢复继承）/ DELETE 删行，均落审计；
// 权限表写失败 → 502 且不写审计（F1 回归）；requireAdmin 403。
// mock 全局 fetch + 带 cookie 的 NextRequest；params 为 Promise（Next 16 async params）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT, DELETE } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';
const CTX = { params: Promise.resolve({ wecom_id: 'ZhangDuo' }) };

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
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                                 // PATCH
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['5', '7'], can_see_cost: true, note: '加店' }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
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
      .mockResolvedValueOnce({ json: async () => [{ id: 7, branch_nums: ['1'], brands: null, categories: null, can_see_cost: false, expires_at: null, note: null }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                                                                                 // DELETE
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: null, brands: null, categories: null, can_see_cost: null }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=in.(7)');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'delete_data_permission', subjectType: 'user', subjectId: 'ZhangDuo', after: null,
    }));
  });

  it('全 null 删行失败 → 502 且不写审计（F1 回归）', async () => {
    fetchMock
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
      .mockResolvedValueOnce({ json: async () => [] })   // 读旧（无行）
      .mockResolvedValueOnce({ ok: true });               // POST
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ subject_type: 'user', subject_id: 'ZhangDuo', branch_nums: ['9'], brands: null, categories: null, can_see_cost: null });
  });

  it('403 for illegal actor（F9）', async () => {
    const res = await PUT(mkReq('PUT', 'insforge_access_token=x; wecom_userid=NotAdmin', { branch_nums: ['9'] }), CTX);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /users/:wecom_id', () => {
  it('删全部 override 行并写 delete 审计', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 7 }, { id: 8 }] })  // 读旧（2 行）
      .mockResolvedValueOnce({ ok: true });                                   // DELETE id=in.(7,8)
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=in.(7,8)');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'delete_data_permission', subjectType: 'user', subjectId: 'ZhangDuo',
      before: expect.objectContaining({ id: 8 }),
    }));
  });

  it('删行失败 → 502 且不写审计（F1 回归）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 7 }] })            // 读旧
      .mockResolvedValueOnce({ ok: false, text: async () => 'del boom' });  // DELETE 失败
    const res = await DELETE(mkReq('DELETE', ADMIN_COOKIE), CTX);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('del boom');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('403 for illegal actor（F9）', async () => {
    const res = await DELETE(mkReq('DELETE', 'insforge_access_token=x; wecom_userid=NotAdmin'), CTX);
    expect(res.status).toBe(403);
  });
});
