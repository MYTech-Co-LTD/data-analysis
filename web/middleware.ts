import { NextResponse, NextRequest } from "next/server";
import { isWecomClient, isMobileDevice } from "@/lib/device";
import {
  checkFeaturePerm,
  decodePermissionsClaim,
  catalogVCheck,
  hasGatePerm,
  type DecodedClaims,
} from "@/lib/feature-perm";
import { checkOffboard } from "@/lib/offboard-check";

// Task 13（S4）：旧形状令牌（无 catalog_v）的 48h TTL——超龄 → 302 /login 刷新提示。
// serverV 与 claims 构建器（functions/wecom-oidc-callback）同源读 CATALOG_V env，缺省 '0'。
const CATALOG_V_SERVER = process.env.CATALOG_V ?? "0";
const STALE_TOKEN_TTL_S = 48 * 3600;

// catalog_v 快/慢路径接线：stale（无 catalog_v）且 iat 超 48h → 需刷新。
// `==` 失败不是拒绝条件（M3.5 防全员锁死）：慢路径 rejected 仅作可观测信号，不据此 302；
// 具体驱逐 key 由 resolveViewKey 解析期校验 + API 实查兜底挡。
function isRefreshRequired(claim: DecodedClaims | undefined): boolean {
  if (!claim) return false;
  const verdict = catalogVCheck(claim, CATALOG_V_SERVER);
  if (verdict.rejected.length > 0) {
    console.warn("[catalog_v] slow-path rejected keys:", verdict.rejected.join(","));
  }
  if (!verdict.stale) return false;
  if (typeof claim.iat !== "number") return false; // iat 缺失不强制（软门禁保守放行）
  return Date.now() / 1000 - claim.iat > STALE_TOKEN_TTL_S;
}

// 报表中心页面门禁（2026-08-18 方案 A）：/reports* 区域（含 /reports/targets）统一由
// gate:reports-center（门禁|报表中心，view-group：成员 view:reports + view:reports-targets）把关，
// 不再按路径分别查 view:reports / view:reports-targets。拒 → 落地页（软门禁，实查兜底不变）。
function isReportsPath(pathname: string): boolean {
  return pathname === "/reports" || pathname.startsWith("/reports/");
}

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
    const claim = decodePermissionsClaim(token);
    // 离职四 sink①（2026-08-17）：企微路径同样接入 is_active 软校验 + blacklist
    // （此前仅 PC 路径查 blacklist，企微端——大多数用户所在端——完全不查，断链）。
    if (await checkOffboard(token, claim?.sub)) {
      return rejectSession(req);
    }
    // S4 旧形状令牌超龄 → 刷新提示（不清 cookie；重新登录即换新形状 claims）
    if (isRefreshRequired(claim)) {
      return redirectToRefresh(req);
    }
    // 检查 admin 路径权限（P0a：checkFeaturePerm 收口，claims 来自 token 不验签解码——
    // 仅 UX 挡板，真实裁决在 API 路由内 requireAdmin）
    if (req.nextUrl.pathname.startsWith("/admin")) {
      const wecomId = req.cookies.get("wecom_userid")?.value;
      if (!wecomId || !(await checkFeaturePerm(wecomId, "data-analysis:admin", claim))) {
        return NextResponse.redirect(new URL("/?error=admin_required", req.url));
      }
    }
    // 报表中心页面门禁（方案 A）：进 /reports* 需 gate:reports-center → 拒则落地页
    if (isReportsPath(req.nextUrl.pathname) && !hasGatePerm(claim?.permissions, "data-analysis:gate:reports-center")) {
      return NextResponse.redirect(new URL("/?error=view_required", req.url));
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

  // 离职四 sink①（2026-08-17）：blacklist（token_hash + sub 双维）+ is_active 软校验统一收口 checkOffboard
  if (await checkOffboard(token, decodePermissionsClaim(token)?.sub)) {
    return rejectSession(req);
  }

  // S4 旧形状令牌超龄 → 刷新提示（不清 cookie；重新登录即换新形状 claims）
  const claim = decodePermissionsClaim(token);
  if (isRefreshRequired(claim)) {
    return redirectToRefresh(req);
  }

  // 检查 admin 路径权限（P0a：同上，checkFeaturePerm 收口）
  if (req.nextUrl.pathname.startsWith("/admin")) {
    const wecomId = req.cookies.get("wecom_userid")?.value;
    if (!wecomId || !(await checkFeaturePerm(wecomId, "data-analysis:admin", claim))) {
      return NextResponse.redirect(new URL("/?error=admin_required", req.url));
    }
  }

  // 报表中心页面门禁（方案 A）：进 /reports* 需 gate:reports-center → 拒则落地页
  if (isReportsPath(req.nextUrl.pathname) && !hasGatePerm(claim?.permissions, "data-analysis:gate:reports-center")) {
    return NextResponse.redirect(new URL("/?error=view_required", req.url));
  }

  return NextResponse.next({ request: req });
}

// S4 刷新提示：302 /login（软门禁——token 仍有效，重登即取到带 catalog_v 的新形状 claims）。
function redirectToRefresh(req: NextRequest): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("error", "refresh_required");
  return NextResponse.redirect(url);
}

// 拒会话：清 cookie + 跳 /login（离职/拉黑用户软着陆到重新登录口，重新登录即被 Casdoor disable 指回）。
function rejectSession(req: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL("/login", req.url));
  response.cookies.delete("insforge_access_token");
  response.cookies.delete("wecom_userid");
  response.cookies.delete("wecom_name");
  return response;
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
