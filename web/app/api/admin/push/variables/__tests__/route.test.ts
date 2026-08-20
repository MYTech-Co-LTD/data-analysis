// web/app/api/admin/push/variables/__tests__/route.test.ts
// 变量点选数据源路由：requireAdmin（admin 闸）→ checkPushPerm(push:configure)（功能闸）
//   → listPushVariables() 透传。mock requireAdmin / checkPushPerm / listPushVariables。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET } from '../route';
import { requireAdmin } from '@/lib/admin-api-auth';
import { checkPushPerm } from '@/app/api/push/route';
import { listPushVariables } from '@/lib/push/admin-service';

vi.mock('@/lib/admin-api-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/app/api/push/route', () => ({ checkPushPerm: vi.fn() }));
vi.mock('@/lib/push/admin-service', () => ({ listPushVariables: vi.fn() }));

const requireAdminMock = vi.mocked(requireAdmin);
const checkPushPermMock = vi.mocked(checkPushPerm);
const listPushVariablesMock = vi.mocked(listPushVariables);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

function denyRes(status: number): NextResponse {
  return NextResponse.json({ ok: false, error: 'admin_required' }, { status });
}

function mkGetReq(cookie?: string) {
  return new NextRequest('http://localhost/api/admin/push/variables', {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

function sampleVars() {
  return [
    { var_code: 'sale_amount', name: '销售额', description: '今日销售总额（元）', metric_code: 'sale_amount', scope_dim: 'store', unit: '元', enabled: true },
    { var_code: 'delivery_amount', name: '配送额', description: null, metric_code: 'delivery_amount', scope_dim: 'store', unit: '元', enabled: true },
  ];
}

beforeEach(() => {
  requireAdminMock.mockReset();
  checkPushPermMock.mockReset();
  listPushVariablesMock.mockReset();
});

describe('requireAdmin 闸', () => {
  it('未登录 → 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await GET(mkGetReq());
    expect(res.status).toBe(401);
  });
  it('非 admin → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(403));
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(403);
  });
});

describe('push:configure 功能闸', () => {
  it('admin 但无 push:configure → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('push:configure required');
  });
  it('身份取自已验签 cookie', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    listPushVariablesMock.mockResolvedValueOnce(sampleVars());
    await GET(mkGetReq(ADMIN_COOKIE));
    expect(checkPushPermMock).toHaveBeenCalledWith('ZhangDuo', 'push:configure');
  });
});

describe('变量列表透传', () => {
  it('200 + variables（含 description，供 UI 只显 name+description）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    listPushVariablesMock.mockResolvedValueOnce(sampleVars());
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.variables).toHaveLength(2);
    expect(body.variables[0]).toMatchObject({ name: '销售额', description: '今日销售总额（元）' });
  });
  it('listPushVariables 抛错 → 502 带 message', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    listPushVariablesMock.mockRejectedValueOnce(new Error('HTTP 500'));
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('HTTP 500');
  });
});
