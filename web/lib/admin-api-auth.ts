// web/lib/admin-api-auth.ts
// /api/admin/** 路由内鉴权（middleware matcher 不盖 /api/**，必须路由内自查）
// F2 加固（安全终检 BLOCKER）：在「cookie 非空 + wecom_userid ∈ ADMIN_USERIDS」之上，
// 增加 access_token 验签（JWT_SECRET / HS256）+ 过期校验 + sub 绑定：
//   token.payload.sub（wecom-oidc-callback 签的 wecom_userid）必须 === cookie wecom_userid，
//   杜绝「伪造 wecom_userid cookie 冒充管理员」——伪造 cookie 者拿不到 ZhangDuo 的合法签名 token。
//   wecom_userid 仍为非 httpOnly（client 展示登录态用），但只读不构成授权凭据。
// fail-close：JWT_SECRET 未注入 → 500（宁可显式故障，也不回退「只看 cookie」的旧行为）。
import { jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_USERIDS } from './auth';

export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  // 函数内读 env（而非模块级常量）：Next dev/HMR 与测试可运行时设值，失效即时生效
  const SECRET = process.env.JWT_SECRET;
  const token = req.cookies.get('insforge_access_token')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const uid = req.cookies.get('wecom_userid')?.value;
  if (!uid || !ADMIN_USERIDS.has(uid)) {
    return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
  }
  if (!SECRET) {
    // 部署漏配 JWT_SECRET：fail-close，禁止降级为无验签放行
    return NextResponse.json({ ok: false, error: 'server_misconfigured' }, { status: 500 });
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), { algorithms: ['HS256'] });
    // sub 绑定：token 身份必须与 cookie 一致，防伪造 cookie 提权
    if (payload.sub !== uid) {
      return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
    }
  } catch {
    // 签名错误 / 已过期 / 畸形 JWT → 未授权
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}