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
    // W6（Task 20）：新令牌形状——data_scope/fields 段（顶层旧四维镜像已摘）
    const payload = Buffer.from(
      JSON.stringify({ data_scope: { branch_nums: ['3120-001'] }, fields: { cost: false } }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toEqual(['3120-001']);
    expect(body.can_see_cost).toBe(false);
  });

  it('双氧期旧令牌：顶层 branch_nums 仍可读（优先级最高），无 fields 段 → 全掩', async () => {
    // 顶层镜像 era 令牌（RLS 终版对无 data_scope 段本就 deny；此处只验证展示边界不炸）
    const payload = Buffer.from(
      JSON.stringify({ branch_nums: ['001'], can_see_cost: true }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toEqual(['001']);           // 旧顶层 key 优先（双氧期令牌展示兼容）
    expect(body.can_see_cost).toBe(false);               // 顶层 can_see_cost 回退已摘（fields 唯一源，W6）
  });

  it('returns 401 on malformed token', async () => {
    // token 非 JWT 格式（无点分隔）→ 解码失败 → 401
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: 'insforge_access_token=not-a-jwt' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('defaults branch_nums to "*" when claim absent（新旧段皆缺 = 历史全权令牌）', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toBe('*');
    expect(body.can_see_cost).toBe(false);               // 无 fields 段 = 全掩（安全方向）
  });

  it('新令牌空 data_scope.branch_nums = 受限∅（deny 展示，不冒充全权）', async () => {
    const payload = Buffer.from(
      JSON.stringify({ data_scope: { branch_nums: [] }, fields: { cost: true } }),
    ).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const req = new NextRequest('http://localhost/api/me', {
      headers: { cookie: `insforge_access_token=${token}` },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.branch_nums).toEqual([]);                // 空数组 = authorized ∅（B1），非 '*'
    expect(body.can_see_cost).toBe(true);
  });
});
