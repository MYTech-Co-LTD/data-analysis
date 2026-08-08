import { headers } from "next/headers";

import {
  buildCasdoorAuthUrl,
  buildWecomQrLoginUrl,
  buildWecomAuthUrl,
} from "@/lib/wecom";
import { isMobileDevice } from "@/lib/device";

/**
 * 登录页（Casdoor 接管后的兜底入口）。
 *
 * 正常路径：middleware 已把未登录用户 307 到 Casdoor；用户落到这里通常是因为
 * Casdoor env 未配置（buildCasdoorAuthUrl 返回 ""）或回调失败带 error。
 *
 * 渲染策略（优先级递减）：
 * 1) Casdoor 登录链接（主 CTA，UA 路由 provider：企微内 Silent / PC 扫码）。
 * 2) 旧企微直连（H5 snsapi_base / PC 扫码 SSO）—— Casdoor 未配置时兜底。
 * 3) 都没配 → "登录未配置"。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith("/") ? next : "/";
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  // 与 middleware / auth/callback 一致：origin 从转发头取，env 优先。
  const proto = headersList.get("x-forwarded-proto") || "https";
  const host = headersList.get("x-forwarded-host") || headersList.get("host") || "";
  const origin = `${proto}://${host}`;
  const casdoorRedirectUri =
    process.env.NEXT_PUBLIC_CASDOOR_REDIRECT_URI || `${origin}/auth/callback`;

  // Casdoor provider 路由（与 middleware 同款）：企微内 Silent，PC 扫码。
  const uaLower = ua.toLowerCase();
  const provider = uaLower.includes("wxwork") ? "wecom_silent" : "wecom_scan";
  const casdoorUrl = buildCasdoorAuthUrl(
    casdoorRedirectUri,
    encodeURIComponent(safeNext),
    provider
  );

  // 旧路径 fallback（仅 Casdoor 未配置时显示，避免双入口困惑）。
  const wecomRedirectBase = process.env.NEXT_PUBLIC_WECOM_REDIRECT_URI || "";
  const sep = wecomRedirectBase.includes("?") ? "&" : "?";
  const wecomRedirectUri = `${wecomRedirectBase}${sep}next=${encodeURIComponent(safeNext)}`;
  const qrUrl = buildWecomQrLoginUrl(wecomRedirectUri, encodeURIComponent(safeNext));
  const h5Url = buildWecomAuthUrl(wecomRedirectUri, encodeURIComponent(safeNext));

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-8 max-w-sm w-full text-center shadow-sm">
        <h1 className="text-xl font-bold mb-2">数据分析平台</h1>
        <p className="text-sm text-muted-foreground mb-6">请使用企业微信登录</p>

        {error ? (
          <p className="text-sm text-red-600 mb-4 break-all">登录失败：{error}</p>
        ) : null}

        {casdoorUrl ? (
          // 主路径：Casdoor 登录（middleware 通常已直接 307，落到这多为兜底）。
          <div className="space-y-4">
            <a
              href={casdoorUrl}
              className="block w-full bg-blue-600 text-white rounded-md py-3 text-sm font-medium hover:bg-blue-700"
            >
              使用企业微信登录
            </a>
            <p className="text-xs text-muted-foreground">
              点击后将跳转到统一登录平台
            </p>
          </div>
        ) : isMobile ? (
          // Casdoor 未配置 · 移动端：旧 H5 snsapi_base 入口。
          h5Url ? (
            <div className="space-y-4">
              <a
                href={h5Url}
                className="block w-full bg-blue-600 text-white rounded-md py-3 text-sm font-medium hover:bg-blue-700"
              >
                企微授权登录
              </a>
              <p className="text-xs text-muted-foreground">
                点击后将跳转到企业微信进行授权
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">企微登录未配置</p>
          )
        ) : (
          // Casdoor 未配置 · PC 端：旧扫码 SSO 入口。
          qrUrl ? (
            <div className="space-y-4">
              <a
                href={qrUrl}
                className="block w-full bg-blue-600 text-white rounded-md py-2.5 text-sm font-medium hover:bg-blue-700"
              >
                企微扫码登录
              </a>
              <p className="text-xs text-muted-foreground">
                点击后将跳转到企业微信扫码页面
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">企微登录未配置</p>
          )
        )}
      </div>
    </div>
  );
}
