// web/app/auth/start/route.ts
// OIDC 登录发起（review B1 CSRF 防护）：单一入口生成 state nonce 并绑定 httpOnly cookie
// （casdoor_state_nonce），state = `${nonce}::${encodeURIComponent(targetPath)}`，
// 再 307 跳 Casdoor authorize。middleware 与 /login 都改指这里——杜绝 state 无绑定可伪造：
// callback 侧比对 cookie nonce，不匹配即拒绝，登录流 CSRF 无法把受害者送进攻击者账号。
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { buildCasdoorAuthUrl } from "@/lib/wecom";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawNext = url.searchParams.get("next") || "/";
  const targetPath = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  // 与 auth/callback 一致：origin 从转发头取，redirect_uri env 优先回退 origin。
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;
  const redirectUri =
    process.env.NEXT_PUBLIC_CASDOOR_REDIRECT_URI || `${origin}/auth/callback`;

  // provider 按 UA 路由（与旧 middleware 行为一致）：企微内 Silent，PC 扫码。
  const ua = req.headers.get("user-agent") || "";
  const provider = ua.toLowerCase().includes("wxwork") ? "wecom_silent" : "wecom_scan";

  // nonce = 随机 128bit；state 前缀必须匹配回调侧 /^[A-Za-z0-9_-]{32,}::/ 校验。
  const nonce = randomUUID();
  const state = `${nonce}::${encodeURIComponent(targetPath)}`;

  const authUrl = buildCasdoorAuthUrl(redirectUri, state, provider);
  if (!authUrl) {
    // Casdoor 未配置 → 兜底 /login（不种 nonce cookie，纯 URL 回跳）。
    const fallback = new URL("/login", origin);
    fallback.searchParams.set("next", targetPath);
    return NextResponse.redirect(fallback);
  }

  const response = NextResponse.redirect(authUrl, 307);
  response.cookies.set("casdoor_state_nonce", nonce, {
    httpOnly: true,
    secure: proto === "https",
    sameSite: "lax",
    path: "/auth/callback", // 仅随回调请求回传，缩小暴露面
    maxAge: 600,            // 10 分钟，与 state 生命周期对齐
  });
  return response;
}