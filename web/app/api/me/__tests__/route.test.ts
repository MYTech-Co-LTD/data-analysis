// web/app/api/me/__tests__/route.test.ts
// F2.1 — /api/me route：解码 cookie JWT 返 branch_nums/can_see_cost claims
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';

describe('/api/me', () => {
  it('returns 401 without token', async () => {
    // 无 cookie → 401
    const req = new NextRequest('http://localhost/api/me');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns claims from token', async () => {
    // 构造一个 payload 含 branch_nums/can_see_cost 的 JWT（header.payload.sig，base64url）
    const payload = Buffer.from(
      JSON.stringify({ branch_nums: ['001'], can_see_cost: false }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toEqual(['001']);
    expect(body.can_see_cost).toBe(false);
  });

  it('returns 401 on malformed token', async () => {
    // token 非 JWT 格式（无点分隔）→ 解码失败 → 401
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: 'insforge_access_token=not-a-jwt' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('defaults branch_nums to "*" when claim absent', async () => {
    // payload 无 branch_nums → 默认 '*'（全权）
    const payload = Buffer.from(JSON.stringify({ can_see_cost: true })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toBe('*');
    expect(body.can_see_cost).toBe(true);
  });
});
