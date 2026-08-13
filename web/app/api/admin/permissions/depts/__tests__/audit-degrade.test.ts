// web/app/api/admin/permissions/depts/__tests__/audit-degrade.test.ts
// F9：审计写失败降级——用【真实 writeAudit】（本文件不 mock permission-audit），
// 让 permission_audit POST fetch reject，主操作仍应返回 {ok:true} 200 且仅记日志不 500。
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PUT } from '../route';

vi.mock('jose', () => ({ jwtVerify: vi.fn(async () => ({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } })) }));

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function mkReq(method: 'PUT', cookie: string, body: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/depts', {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PUT /depts — 审计失败降级', () => {
  it('permission_audit POST reject 时仍返回 ok:true 200（主操作不阻断）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] })                                                                               // 读旧（无行）
      .mockResolvedValueOnce({ ok: true })                                                                                            // POST data_permissions（权限表写成功）
      .mockResolvedValueOnce({ ok: true, json: async () => [{ name: '张朵' }] })                                                       // writeAudit 查 actor_name
      .mockRejectedValueOnce(new Error('audit post down'));                                                                           // writeAudit 写审计 fetch reject
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: ['1'] }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(console.error).toHaveBeenCalled(); // 失败仅记日志
  });

  it('permission_audit POST 返回 4xx 时仍返回 ok:true 200（r.ok 检查记日志不静默）', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] })                                                                               // 读旧（无行）
      .mockResolvedValueOnce({ ok: true })                                                                                            // POST data_permissions
      .mockResolvedValueOnce({ ok: true, json: async () => [{ name: '张朵' }] })                                                       // 查 actor_name
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'audit 500' });                                               // 审计 POST 4xx/5xx
    const res = await PUT(mkReq('PUT', ADMIN_COOKIE, { id: 'd1', branch_nums: ['1'] }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });
});
