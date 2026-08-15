// web/lib/admin-api-auth.test.ts
// requireAdmin 安全分支全覆盖（F2 安全终检 BLOCKER）：
//   验签放行 / 签名错 / 过期 / 畸形 → 401；sub ≠ cookie（伪造 wecom_userid 提权）→ 403；
//   非 admin uid → 403；无 token → 401；JWT_SECRET 缺失 → 500（fail-close，绝不降级只看 cookie）。
// jose 被 mock：jwtVerify 的 resolve/reject 与 payload.sub 完全由测试控制，
// 从而能独立演练各分支，不依赖真实签名。
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { requireAdmin } from './admin-api-auth';

const jwtVerifyMock = vi.fn();
vi.mock('jose', () => ({ jwtVerify: (...a: unknown[]) => jwtVerifyMock(...a) }));

function mkReq(cookie?: string) {
  return new NextRequest('http://localhost/api/admin/permissions/roles', {
    headers: cookie ? { cookie } : {},
  });
}

beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });
beforeEach(() => { jwtVerifyMock.mockReset(); delete process.env.BREAKGLASS_ADMINS; });
afterEach(() => { process.env.JWT_SECRET = 'test-secret'; delete process.env.BREAKGLASS_ADMINS; });

describe('requireAdmin', () => {
  it('合法 token + sub==cookie + claims 含 admin 权限 → 放行（返回 null）', async () => {
    // P0a：admin 判定走 checkFeaturePerm，token claims 优先（permissions 数组透传）
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'ZhangDuo', permissions: ['data-analysis:admin'] }, protectedHeader: { alg: 'HS256' } });
    const res = await requireAdmin(mkReq('insforge_access_token=valid; wecom_userid=ZhangDuo'));
    expect(res).toBeNull();
  });

  it('token 无 permissions claim 但 uid ∈ BREAKGLASS_ADMINS → 放行（兜底+审计）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BREAKGLASS_ADMINS = 'ZhangDuo';
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'ZhangDuo' }, protectedHeader: { alg: 'HS256' } });
    const res = await requireAdmin(mkReq('insforge_access_token=valid; wecom_userid=ZhangDuo'));
    expect(res).toBeNull();
    expect(warn).toHaveBeenCalledWith('[breakglass]', 'ZhangDuo', 'data-analysis:admin');
  });

  it('签名错 / 已过期 / 畸形 JWT → 401 unauthorized（fetch 不产生副作用）', async () => {
    jwtVerifyMock.mockRejectedValueOnce(new Error('invalid signature'));
    const res = await requireAdmin(mkReq('insforge_access_token=garbage; wecom_userid=ZhangDuo'));
    expect(res?.status).toBe(401);

    jwtVerifyMock.mockRejectedValueOnce(new Error('jwt expired'));
    const res2 = await requireAdmin(mkReq('insforge_access_token=expired; wecom_userid=ZhangDuo'));
    expect(res2?.status).toBe(401);
  });

  it('sub ≠ cookie wecom_userid（伪造 cookie 提权）→ 403', async () => {
    // 攻击者伪造 wecom_userid=ZhangDuo 但 token 实际签给 NotAdmin
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'NotAdmin' }, protectedHeader: { alg: 'HS256' } });
    const res = await requireAdmin(mkReq('insforge_access_token=forged; wecom_userid=ZhangDuo'));
    expect(res?.status).toBe(403);
  });

  it('JWT_SECRET 未注入 → 500 server_misconfigured（fail-close，不降级为只看 cookie）', async () => {
    delete process.env.JWT_SECRET;
    const res = await requireAdmin(mkReq('insforge_access_token=any; wecom_userid=ZhangDuo'));
    expect(res?.status).toBe(500);
    expect(jwtVerifyMock).not.toHaveBeenCalled(); // 压根不尝试验签
  });

  it('非 admin uid（即使 token 合法）→ 403', async () => {
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'SomeoneElse' }, protectedHeader: { alg: 'HS256' } });
    const res = await requireAdmin(mkReq('insforge_access_token=valid; wecom_userid=SomeoneElse'));
    expect(res?.status).toBe(403);
  });

  it('无 token cookie → 401', async () => {
    const res = await requireAdmin(mkReq('wecom_userid=ZhangDuo'));
    expect(res?.status).toBe(401);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});