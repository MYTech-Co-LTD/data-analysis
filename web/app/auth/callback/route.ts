import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { exchangeCasdoorCode } from "@/lib/wecom";

/**
 * Casdoor OIDC 回调
 * state 参数格式：URL 编码的目标路径（如 /reports/123）
 *
 * 流程：Casdoor authorize 回跳带 code → 调 wecom-oidc-callback function
 * 换 PostgREST JWT → 写 cookie（middleware + PostgREST 消费，RLS 依赖）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "/";

  // 解码 state 中的目标路径
  const targetPath = decodeURIComponent(state);
  const safeTarget = targetPath.startsWith("/") ? targetPath : "/";

  // 用 X-Forwarded-Host / Host 头构造外部 origin，避免 Next.js 把 req.url 解析成
  // 容器内监听地址（0.0.0.0:3000）导致 redirect 的 Location 跳到内网而打不开。
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;
  // redirect_uri 必须与浏览器跳转 Casdoor 时用的一致（env 优先，回退到当前 origin）。
  const redirectUri =
    process.env.NEXT_PUBLIC_CASDOOR_REDIRECT_URI || `${origin}/auth/callback`;

  const login = (err: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, origin));

  if (!code) return login("missing_code");

  const { data, error } = await exchangeCasdoorCode(code, redirectUri);
  if (error || !data?.ok || !data.access_token) {
    return login(String((data as any)?.error ?? error ?? "exchange_failed"));
  }

  const c = await cookies();
  // 判断是否为 HTTPS（根据 x-forwarded-proto）
  const isHttps = proto === "https";

  // httpOnly：server（middleware + api.ts）鉴权用，client 读不到
  c.set("insforge_access_token", data.access_token, {
    httpOnly: true,
    secure: isHttps,  // 仅 HTTPS 下启用 secure
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });
  // 非 httpOnly：Header（client）展示登录态用
  c.set("wecom_userid", data.wecom_userid, {
    httpOnly: false,
    secure: isHttps,  // 仅 HTTPS 下启用 secure
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });
  // 用户姓名（优先显示姓名，fallback 到 userid）
  if (data.wecom_name) {
    c.set("wecom_name", data.wecom_name, {
      httpOnly: false,
      secure: isHttps,  // 仅 HTTPS 下启用 secure
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 86400,
    });
  }

  // 回跳到原路径
  return NextResponse.redirect(new URL(safeTarget, origin));
}
