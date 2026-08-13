// web/app/api/admin/permissions/users/__tests__/route.test.ts
// 权限管理 users 路由：GET 部门列表从 data_permissions(dept 行) 聚合 + PUT 角色指派（assign_role 审计）+ requireAdmin 拒绝。
// mock 全局 fetch（直连 PostgREST）+ 带 cookie 的 NextRequest。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

function mkReq(method: 'GET' | 'PUT', cookie?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/users', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

beforeEach(() => {
  fetchMock.mockReset();
  writeAuditMock.mockReset();
});

describe('GET /users — requireAdmin', () => {
  it('401 without token', async () => {
    const res = await GET(mkReq('GET'));
    expect(res.status).toBe(401);
  });

  it('403 for illegal actor (wecom_userid not in ADMIN_USERIDS)', async () => {
    const res = await GET(mkReq('GET', 'insforge_access_token=x; wecom_userid=NotAdmin'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('admin_required');
  });
});

describe('GET /users — 列表聚合', () => {
  it('部门列合并 data_permissions dept 行（未配置 → null）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ wecom_id: 'ZhangDuo', name: '张朵', department_ids: ['d1'], role_id: 1, role_source: 'auto' }] })
      .mockResolvedValueOnce({ json: async () => [{ id: 1, code: 'boss', name: '老板/运营总' }] })
      .mockResolvedValueOnce({ json: async () => [{ id: 'd1', name: '运营部', parent_id: null, is_active: true }, { id: 'd2', name: '采购部', parent_id: null, is_active: true }] })
      .mockResolvedValueOnce({ json: async () => [{ subject_id: 'd1', branch_nums: ['1', '2'], can_see_cost: true }] });
    const res = await GET(mkReq('GET', ADMIN_COOKIE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.roles).toHaveLength(1);
    const d1 = body.departments.find((d: { id: string }) => d.id === 'd1');
    const d2 = body.departments.find((d: { id: string }) => d.id === 'd2');
    expect(d1).toMatchObject({ id: 'd1', name: '运营部', branch_nums: ['1', '2'], can_see_cost: true });
    expect(d2).toMatchObject({ id: 'd2', branch_nums: null, can_see_cost: null });
  });
});

describe('PUT /users — 角色指派', () => {
  it('role_id=null 恢复 auto，PATCH 成功后落 assign_role 审计（F4）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ role_id: 5, role_source: 'manual' }] })  // 读旧
      .mockResolvedValueOnce({ ok: true });                                                    // PATCH org_users
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { wecom_id: 'ZhangDuo', role_id: null }));
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('org_users');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toMatchObject({ role_id: null, role_source: 'auto' });
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'assign_role', subjectType: 'user', subjectId: 'ZhangDuo',
      before: expect.objectContaining({ role_id: 5, role_source: 'manual' }),
      after: expect.objectContaining({ wecom_id: 'ZhangDuo', role_id: null, role_source: 'auto' }),
    }));
  });

  it('PATCH 失败 → 502 且不落审计', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] })
      .mockResolvedValueOnce({ ok: false, text: async () => 'boom' });
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { wecom_id: 'ZhangDuo', role_id: 2 }));
    expect(res.status).toBe(502);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('缺 wecom_id → 400', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { role_id: 1 }));
    expect(res.status).toBe(400);
  });
});
