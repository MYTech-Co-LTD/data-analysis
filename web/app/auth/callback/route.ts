import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { exchangeCasdoorCode } from "@/lib/wecom";

/**
 * Casdoor OIDC 回调
 * state 参数格式：`${nonce}::${encodeURIComponent(targetPath)}`（review B1 CSRF 修复）。
 *
 * 流程：Casdoor authorize 回跳带 code → 校验 cookie nonce 与 state nonce 一致（登录 CSRF 防护）
 * → 调 wecom-oidc-callback function 换 PostgREST JWT → 写 cookie（middleware + PostgREST 消费，RLS 依赖）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";

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

  const c = await cookies();

  // ---- B1：校验 state nonce 绑定（CSRF 登录防护） ----
  // state 前段 = /auth/start 种的 cookie nonce。缺 cookie / 不匹配 → 拒绝，走后 login 兜底。
  const STATE_SEP = "::";
  const sepIdx = state.indexOf(STATE_SEP);
  const stateNonce = sepIdx > 0 ? state.slice(0, sepIdx) : "";
  const savedNonce = c.get("casdoor_state_nonce")?.value;
  // 一次性使用：无论成败先清除，防重放。
  c.delete("casdoor_state_nonce");

  if (!code) return login("missing_code");
  if (!stateNonce || !savedNonce || stateNonce !== savedNonce) {
    return login("state_mismatch");
  }

  // 解析目标路径：state 后段是 encodeURIComponent 的目标路径；解码失败或非站内路径 → "/"。
  let targetPath: string;
  try {
    targetPath = decodeURIComponent(sepIdx >= 0 ? state.slice(sepIdx + STATE_SEP.length) : "");
  } catch {
    targetPath = "";
  }
  const safeTarget = targetPath.startsWith("/") && !targetPath.startsWith("//") ? targetPath : "/";

  const { data, error } = await exchangeCasdoorCode(code, redirectUri, state);
  if (error || !data?.ok || !data.access_token) {
    return login(String((data as any)?.error ?? error ?? "exchange_failed"));
  }

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
