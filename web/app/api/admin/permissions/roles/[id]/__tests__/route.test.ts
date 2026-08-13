// web/app/api/admin/permissions/roles/[id]/__tests__/route.test.ts
// 角色 PUT：参数写 roles、默认范围写 data_permissions(role 行)，均落 update_role 审计。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PUT } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';
const CTX = { params: Promise.resolve({ id: '1' }) };

function mkReq(method: 'PUT', cookie?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/roles/1', {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  writeAuditMock.mockReset();
});

describe('PUT /roles/:id', () => {
  it('只传参数 → PATCH roles + 审计', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ code: 'boss', name: '老板/运营总', default_landing: '/', default_metric: null, visible_panels: [], is_active: true }] })  // 旧 roles
      .mockResolvedValueOnce({ json: async () => [] })                                                                                                                 // 旧 perm（无行）
      .mockResolvedValueOnce({ ok: true });                                                                                                                            // PATCH roles
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_landing: '/my-store' }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('roles?id=eq.1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ default_landing: '/my-store' });
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update_role', subjectType: 'role', subjectId: '1',
      after: { default_landing: '/my-store' },
    }));
  });

  it('传范围字段 → upsert role 行（未提供维 = 旧值合并）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ code: 'boss', name: '老板/运营总', default_landing: '/', default_metric: null, visible_panels: [], is_active: true }] })  // 旧 roles
      .mockResolvedValueOnce({ json: async () => [{ id: 9, branch_nums: ['1'], brands: ['3120'], categories: null, can_see_cost: false }] })                              // 旧 perm
      .mockResolvedValueOnce({ ok: true });                                                                                                                            // PATCH data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['2', '3'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.9');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    // 未提供的 brands 保留旧值 ['3120']；categories 旧值 null 仍 null；can_see_cost 旧值 false
    expect(sent).toMatchObject({ branch_nums: ['2', '3'], brands: ['3120'], categories: null, can_see_cost: false, note: '角色tab修改' });
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'update_role' }));
  });

  it('bad id → 400', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_landing: '/' }), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(400);
  });

  it('403 for illegal actor', async () => {
    const res = await PUT(mkReq('PUT', 'insforge_access_token=x; wecom_userid=NotAdmin', { default_landing: '/' }), CTX);
    expect(res.status).toBe(403);
  });
});
