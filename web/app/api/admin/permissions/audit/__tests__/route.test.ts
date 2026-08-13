// web/app/api/admin/permissions/audit/__tests__/route.test.ts
// 审计列表 GET：分页倒序（默认 50、上限 200）；requireAdmin 拒绝。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

function mkReq(method: 'GET', url: string, cookie?: string) {
  return new NextRequest(url, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => fetchMock.mockReset());

describe('GET /audit', () => {
  it('默认 limit=50 倒序返回 items', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ id: 2, actor_wecom_id: 'ZhangDuo', action: 'upsert_data_permission', subject_type: 'dept', subject_id: 'd1', payload_before: null, payload_after: {}, created_at: '2026-08-13T10:00:00Z' }] });
    const res = await GET(mkReq('GET', 'http://localhost/api/admin/permissions/audit', ADMIN_COOKIE));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 2, action: 'upsert_data_permission', subject_type: 'dept' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('order=created_at.desc,id.desc');
    expect(url).toContain('limit=50');
  });

  it('limit 参数生效且上限 200', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await GET(mkReq('GET', 'http://localhost/api/admin/permissions/audit?limit=10', ADMIN_COOKIE));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=10');

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await GET(mkReq('GET', 'http://localhost/api/admin/permissions/audit?limit=9999', ADMIN_COOKIE));
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(url2).toContain('limit=200');
  });


  it('负 limit 下限 clamp 到 1（F8）', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await GET(mkReq('GET', 'http://localhost/api/admin/permissions/audit?limit=-5', ADMIN_COOKIE));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=1');
  });
  it('403 for illegal actor', async () => {
    const res = await GET(mkReq('GET', 'http://localhost/api/admin/permissions/audit', 'insforge_access_token=x; wecom_userid=NotAdmin'));
    expect(res.status).toBe(403);
  });
});
