import { NextResponse, NextRequest } from "next/server";
import { isWecomClient, isMobileDevice } from "@/lib/device";
import { checkFeaturePerm, decodePermissionsClaim } from "@/lib/feature-perm";

export async function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent")?.toLowerCase() || "";
  const isWecom = isWecomClient(ua);

  const deviceTypeCookie = req.cookies.get("device_type")?.value;
  const isMobile = deviceTypeCookie === "mobile" ||
    (!deviceTypeCookie && isMobileDevice(ua));

  const newHeaders = new Headers(req.headers);
  newHeaders.set("x-device-type", isMobile ? "mobile" : "desktop");

  const newReq = new NextRequest(req.url, {
    headers: newHeaders,
    method: req.method,
    body: req.body,
  });

  let response: NextResponse;

  if (isWecom) {
    response = await handleWecomClient(newReq);
  } else {
    response = await handleRegularBrowser(newReq);
  }

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  if (!deviceTypeCookie) {
    response.cookies.set("device_type", isMobile ? "mobile" : "desktop", {
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 86400,
    });
  }

  return response;
}

// redirectToCasdoor: 未登录用户统一改跳 /auth/start（B1 CSRF 修复，单一入口）。
//
// - /auth/start 生成 state nonce + 绑定 httpOnly cookie，再 307 到 Casdoor authorize；
//   middleware 只负责指路，不重复协商 provider / redirect_uri（防两处漂移）。
// - targetPath（pathname+search）由 NextRequest.searchParams 编码，不会破坏查询串。
function redirectToCasdoor(req: NextRequest, targetPath: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/auth/start";
  url.searchParams.set("next", targetPath);
  return NextResponse.redirect(url);
}

async function handleWecomClient(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;

  if (token) {
    // 检查 admin 路径权限（P0a：checkFeaturePerm 收口，claims 来自 token 不验签解码——
    // 仅 UX 挡板，真实裁决在 API 路由内 requireAdmin）
    if (req.nextUrl.pathname.startsWith("/admin")) {
      const wecomId = req.cookies.get("wecom_userid")?.value;
      if (!wecomId || !(await checkFeaturePerm(wecomId, "data-analysis:admin", decodePermissionsClaim(token)))) {
        return NextResponse.redirect(new URL("/?error=admin_required", req.url));
      }
    }
    return NextResponse.next({ request: req });
  }

  // 未登录：跳 Casdoor（Silent provider，企微内无感）。
  const targetPath = req.nextUrl.pathname + req.nextUrl.search;
  return redirectToCasdoor(req, targetPath);
}

async function handleRegularBrowser(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;

  if (!token) {
    // 未登录：跳 Casdoor（wecom_scan provider，PC 扫码）。
    const targetPath = req.nextUrl.pathname + req.nextUrl.search;
    return redirectToCasdoor(req, targetPath);
  }

  const isBlacklisted = await checkTokenBlacklist(token);
  if (isBlacklisted) {
    const response = NextResponse.redirect(new URL("/login", req.url));
    response.cookies.delete("insforge_access_token");
    response.cookies.delete("wecom_userid");
    response.cookies.delete("wecom_name");
    return response;
  }

  // 检查 admin 路径权限（P0a：同上，checkFeaturePerm 收口）
  if (req.nextUrl.pathname.startsWith("/admin")) {
    const wecomId = req.cookies.get("wecom_userid")?.value;
    if (!wecomId || !(await checkFeaturePerm(wecomId, "data-analysis:admin", decodePermissionsClaim(token)))) {
      return NextResponse.redirect(new URL("/?error=admin_required", req.url));
    }
  }

  return NextResponse.next({ request: req });
}

async function checkTokenBlacklist(token: string): Promise<boolean> {
  try {
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";
    const response = await fetch(
      `${baseUrl}/rest/v1/token_blacklist?token_hash=eq.${tokenHash}&select=id`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      }
    );

    if (!response.ok) {
      console.error("Blacklist query failed:", response.status);
      return false;
    }

    const data = await response.json();
    return data.length > 0;
  } catch (e) {
    console.error("Blacklist check failed:", e);
    return false;
  }
}

export const config = {
  matcher: [
    "/",
    "/reports/:path*",
    "/mobile",
    "/mobile/reports/:path*",
    "/admin/:path*"  // 新增这一行
  ],
};
