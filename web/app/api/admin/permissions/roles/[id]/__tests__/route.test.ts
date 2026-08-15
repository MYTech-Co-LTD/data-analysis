// web/app/api/admin/permissions/roles/[id]/__tests__/route.test.ts
// 角色 PUT：参数写 roles、默认范围写 data_permissions(role 行)，均落 update_role 审计；
// 范围维语义（NIT-1）：body 显式出现的字段直写（null=清空该维），未出现的字段保留旧值；四维全 null → 删行。
// 范围写失败 → 502 且不写审计（F2 回归）；id 非整数 → 400（F7）。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PUT } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; process.env.BREAKGLASS_ADMINS = 'ZhangDuo'; vi.spyOn(console, 'warn').mockImplementation(() => {}); }); // P0a：admin 门禁切 checkFeaturePerm，测试 token 无 permissions claim → 走 BREAKGLASS 兜底

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

const OLD_ROLE = [{ code: 'boss', name: '老板/运营总', default_landing: '/', default_metric: null, visible_panels: [], is_active: true }];
const OLD_PERM_WITH_VALUES = [{ id: 9, branch_nums: ['1'], brands: ['3120'], categories: null, can_see_cost: false }];

beforeEach(() => {
  fetchMock.mockReset();
  writeAuditMock.mockReset();
});

describe('PUT /roles/:id', () => {
  it('只传参数 → PATCH roles + 审计（after=rolePatch）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })     // 旧 roles
      .mockResolvedValueOnce({ json: async () => [] })            // 旧 perm（无行）
      .mockResolvedValueOnce({ ok: true });                       // PATCH roles
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_landing: '/my-store' }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('roles?id=eq.1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ default_landing: '/my-store' });
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update_role', subjectType: 'role', subjectId: 'boss',
      after: { default_landing: '/my-store' },
    }));
  });

  it('未出现的范围维保留旧值合并写入；审计 after 仅含出现字段（F3）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: true });                       // PATCH data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['2', '3'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.9');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    // DB 写整行：出现字段直写；未出现的 brands/categories/can_see_cost 保留旧值
    expect(sent).toMatchObject({ branch_nums: ['2', '3'], brands: ['3120'], categories: null, can_see_cost: false, note: '角色tab修改' });
    // 审计 after 排除未出现字段
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update_role',
      after: { branch_nums: ['2', '3'] },
    }));
  });

  it('显式 null 单维 → 清空该维（写入 NULL 不落旧值）（NIT-1 回归）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: true });                       // PATCH data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: null }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.9');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    expect(sent.branch_nums).toBeNull(); // 显式 null 直写，而不是回退旧值 ['1']
    expect(sent.brands).toEqual(['3120']); // 未出现的维保留旧值
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update_role', after: { branch_nums: null },
    }));
  });

  it('四维全 null（显式）→ 整行删，审计 after=全 null（F9/NIT-1）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: true });                       // DELETE data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: null, brands: null, categories: null, can_see_cost: null }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('data_permissions?id=eq.9');
    expect(init.method).toBe('DELETE');
    expect(writeAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'update_role', subjectId: 'boss',
      after: { branch_nums: null, brands: null, categories: null, can_see_cost: null },
    }));
  });

  it('范围写失败 → 502 且不写审计（F2 回归）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: false, text: async () => 'scope boom' });   // PATCH 失败
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['9'] }), CTX);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('scope boom');
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('visible_panels 非字符串数组 → 400（review #5）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { visible_panels: 'targets' }), CTX);
    expect(res.status).toBe(400);
    const res2 = await PUT(mkReq('PUT', ADMIN_COOKIE, { visible_panels: [1, 2] }), CTX);
    expect(res2.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled(); // 校验提前，不读库
  });

  it('visible_panels 空数组 → null 规范化写入（review #5）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: true });                 // PATCH roles
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { visible_panels: [] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toContain('roles?id=eq.1');
    expect(JSON.parse(init.body as string)).toEqual({ visible_panels: null });
  });

  it('default_metric 非字符串 → 400（review #5）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_metric: 42 }), CTX);
    expect(res.status).toBe(400);
  });

  it('is_active 类型混淆 → 400（review #5）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { is_active: 1 }), CTX);
    expect(res.status).toBe(400);
  });

  it('bad id / 非整数 id → 400（F7）', async () => {
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_landing: '/' }), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(400);
    const res2 = await PUT(mkReq('PUT', ADMIN_COOKIE, { default_landing: '/' }), { params: Promise.resolve({ id: '1.5' }) });
    expect(res2.status).toBe(400);
  });

  it('403 for illegal actor', async () => {
    const res = await PUT(mkReq('PUT', 'insforge_access_token=x; wecom_userid=NotAdmin', { default_landing: '/' }), CTX);
    expect(res.status).toBe(403);
  });

  it('角色不存在 → 404，不写任何范围行（F7 防幽灵行）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] });  // 旧 roles：无此行（perm 按 code 读，此处已提前 return）
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['1'] }), CTX);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('角色不存在');
    // 只读了一处（roles），无任何写调用
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(fetchMock.mock.calls.every(([, init]) => !init || init.method === undefined || init.method === 'GET')).toBe(true);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it('非字符串数组 → 400（F6）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES });
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: [1, 2] }), CTX);
    expect(res.status).toBe(400);
    const res2 = await PUT(mkReq('PUT', ADMIN_COOKIE, { categories: 'all' }), CTX);
    expect(res2.status).toBe(400);
  });

  it('can_see_cost 类型混淆 → 400（F6）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES });
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { can_see_cost: 1 }), CTX);
    expect(res.status).toBe(400);
  });

  it('新范围行 POST → 按 code 读、subject_id 写 roles.code（168 键统一回归）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => [] })   // 旧 perm：无行
      .mockResolvedValueOnce({ ok: true });              // POST data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: ['7'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [permReadUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(permReadUrl).toContain('subject_type=eq.role&subject_id=eq.boss'); // 读按 code
    const [postUrl, postInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(postUrl).toContain('/data_permissions');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toMatchObject({ subject_type: 'role', subject_id: 'boss', branch_nums: ['7'] }); // 写 code 非 role_id::text
  });

  it('显式空数组维 == 清空该维（F4 规范化）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => OLD_ROLE })
      .mockResolvedValueOnce({ json: async () => OLD_PERM_WITH_VALUES })
      .mockResolvedValueOnce({ ok: true });                       // PATCH data_permissions
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { branch_nums: [], brands: ['3120'] }), CTX);
    expect((await res.json()).ok).toBe(true);
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ branch_nums: null, brands: ['3120'], categories: null, can_see_cost: false }); // 空数组 → null；未出现维保留旧值
  });
});
