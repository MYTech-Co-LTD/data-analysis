// web/app/api/admin/permissions/roles/__tests__/route.test.ts
// 角色列表 GET：roles 参数 + data_permissions(subject_type='role') 默认范围行聚合。
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

function mkReq(method: 'GET', cookie?: string) {
  return new NextRequest('http://localhost/api/admin/permissions/roles', {
    method,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => fetchMock.mockReset());

describe('GET /roles', () => {
  it('合并角色默认范围行（未配置 → null）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 1, code: 'boss', name: '老板/运营总', default_landing: '/', default_metric: 'sale', visible_panels: ['targets'], is_active: true }] })
      .mockResolvedValueOnce({ json: async () => [{ subject_id: 'boss', branch_nums: ['1', '2'], brands: ['3120'], categories: ['水果'], can_see_cost: true }] }); // 168 起 role 行键 = roles.code
    const res = await GET(mkReq('GET', ADMIN_COOKIE));
    const body = await res.json();
    expect(body.roles[0]).toMatchObject({
      id: 1, code: 'boss', default_landing: '/',
      branch_nums: ['1', '2'], brands: ['3120'], categories: ['水果'], can_see_cost: true,
    });
  });

  it('403 for illegal actor', async () => {
    const res = await GET(mkReq('GET', 'insforge_access_token=x; wecom_userid=NotAdmin'));
    expect(res.status).toBe(403);
  });
});
