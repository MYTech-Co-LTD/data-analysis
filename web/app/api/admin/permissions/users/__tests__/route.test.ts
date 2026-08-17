// web/app/api/admin/permissions/users/__tests__/route.test.ts
// 权限管理 users 路由：GET 部门列表从 data_permissions(dept 行) 聚合 + 仅 GET（2026-08-17 收口：PUT 角色指派随 185 sunset 下线）。
// mock 全局 fetch（直连 PostgREST）+ 带 cookie 的 NextRequest。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import { writeAudit } from '@/lib/permission-audit';

vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

// P0a：requireAdmin 切 checkFeaturePerm（claims 优先 + BREAKGLASS_ADMINS env 兜底），
// 测试 token payload 无 permissions claim → 走 BREAKGLASS 路径；静音 [breakglass] 审计日志
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.BREAKGLASS_ADMINS = 'ZhangDuo';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const writeAuditMock = vi.mocked(writeAudit);

function mkReq(method: 'GET', cookie?: string, body?: unknown) {
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

  it('403 for illegal actor (wecom_userid 无 admin 权限：claims 无命中且不在 BREAKGLASS)', async () => {
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

