// web/app/api/admin/permissions/depts/__tests__/route.test.ts
// 部门权限路由：GET 合并 dept 权限行 + 自动角色；PUT upsert dept 行并写审计；requireAdmin 拒绝。
// mock 全局 fetch + 带 cookie 的 NextRequest。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; process.env.BREAKGLASS_ADMINS = 'ZhangDuo'; vi.spyOn(console, 'warn').mockImplementation(() => {}); }); // P0a：admin 门禁切 checkFeaturePerm，测试 token 无 permissions claim → 走 BREAKGLASS 兜底

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

function mkReq(method: 'GET' | 'PUT', cookie?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/depts', {
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

describe('GET /depts', () => {
  it('合并 dept 权限行与自动角色', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 'd1', name: '运营部', parent_id: null, is_active: true }] })
      .mockResolvedValueOnce({ json: async () => [{ subject_id: 'd1', branch_nums: ['1', '2'], can_see_cost: true }] })
      .mockResolvedValueOnce({ json: async () => [{ dept_id: 'd1', role_id: 1 }] })
      .mockResolvedValueOnce({ json: async () => [{ id: 1, code: 'boss', name: '老板/运营总' }] });
    const res = await GET(mkReq('GET', ADMIN_COOKIE));
    expect((await res.json()).departments[0]).toMatchObject({
      id: 'd1', branch_nums: ['1', '2'], can_see_cost: true, auto_role_id: 1, auto_role_name: '老板/运营总',
    });
  });

  it('403 for illegal actor', async () => {
    const res = await GET(mkReq('GET', 'insforge_access_token=x; wecom_userid=NotAdmin'));
    expect(res.status).toBe(403);
  });
});

describe('PUT /depts', () => {
  it('无旧行 → POST 新建并写审计', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] })   // 读旧（无行）
      .mockResolvedValueOnce({ ok: true });               // POST data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: ['5', '7'], can_see_cost: false }));
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('data_permissions');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ subject_type: 'dept', subject_id: 'd1', branch_nums: ['5', '7'], can_see_cost: false });
    expect(sent.brands).toBeNull();
    expect(sent.categories).toBeNull();
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'upsert_data_permission', subjectType: 'dept', subjectId: 'd1', before: null,
    }));
  });

  it('有旧行 → PATCH：显式出现的字段直写，未出现的保留旧值（F10 合并回归）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 3, branch_nums: ['1'], brands: null, categories: null, can_see_cost: true, expires_at: null, note: null }] })
      .mockResolvedValueOnce({ ok: true });
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: ['9'] }));
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ branch_nums: ['9'], can_see_cost: true, note: '部门tab修改' }); // can_see_cost 未出现 → 保留旧值 true，不得 ?? null 清空
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ before: expect.objectContaining({ id: 3 }) }));
  });

  it('只传 can_see_cost → branch_nums 保留旧值（F10 双向合并）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 3, branch_nums: ['1'], brands: null, categories: null, can_see_cost: true, expires_at: null, note: null }] })
      .mockResolvedValueOnce({ ok: true });
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', can_see_cost: false }));
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ branch_nums: ['1'], can_see_cost: false, note: '部门tab修改' });
  });

  it('显式全 null（含空数组规范化）→ 删行恢复继承，审计 after=null（F4/F10）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 3, branch_nums: ['1'], brands: null, categories: null, can_see_cost: true, expires_at: null, note: null }] })
      .mockResolvedValueOnce({ ok: true });   // DELETE
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: [], can_see_cost: null }));
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.3');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'delete_data_permission', subjectType: 'dept', subjectId: 'd1', after: null,
    }));
  });

  it('全 null + 无旧行 → no-op，不建全 NULL 垃圾行（review #2）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] });   // 读旧（无行）——无任何写应发生
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: [], can_see_cost: null }));
    expect((await res.json()).ok).toBe(true);
    // 只做了一次读查询：全 null + 无旧行 = 本即「未配置」，不得 POST 全 NULL 行 + 无意义审计
    expect(fetchMock.mock.calls.length).toBe(1);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('data_permissions?select');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('branch_nums 非字符串数组 → 400（F6）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: [1, 2] }));
    expect(res.status).toBe(400);
  });

  it('can_see_cost 类型混淆 → 400（F6）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', can_see_cost: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('缺 id → 400', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['1'] }));
    expect(res.status).toBe(400);
  });

  it('403 for illegal actor（F9）', async () => {
    const res = await PUT(mkReq('PUT', 'insforge_access_token=x; wecom_userid=NotAdmin', { id: 'd1', branch_nums: ['1'] }));
    expect(res.status).toBe(403);
  });
});
