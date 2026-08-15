// web/lib/feature-perm.ts
// 功能门禁单模块收口（spec §6.2 / plan Task 3，P0a）：
// 禁止散落 `userid === '...'` 式判断——所有功能级授权统一走 checkFeaturePerm，
// 后续切 casbin 是 1 处切换而非 N 处 hunt-and-replace。
// P0a 判定链：token claims 命中 → true；BREAKGLASS_ADMINS env 命中 → true（记审计）；
// 两者皆无 → false（fail-close）。BREAKGLASS 默认空 = 兜底关闭。
export async function checkFeaturePerm(
  userId: string,
  perm: string,
  claims?: { permissions?: string[] }
): Promise<boolean> {
  // 1. token claims 命中 → 放行（U2 后 callback 会把 Casdoor roles/permissions 平铺进 claims）
  if (claims?.permissions?.includes(perm)) {
    return true;
  }
  // U2+: casbin 实查（5min 缓存 + fail-close + 24h stale，裁决-1 已裁启用
  // ——checkFeaturePermPerm API 路径，本 task 不实现
  // 2. BREAKGLASS 兜底：Casdoor 不可用时的管理入口（逗号分隔 userid，默认空）
  const breakglassAdmins = (process.env.BREAKGLASS_ADMINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (userId && breakglassAdmins.includes(userId)) {
    console.warn('[breakglass]', userId, perm);
    return true;
  }
  // 3. 两者皆无 → 拒绝
  return false;
}

// decodePermissionsClaim：从 JWT 中不验签解出 permissions claim（仅 UX 层软门禁用，
// 如 middleware 页面重定向）。真实授权裁决必须走 jwtVerify 后的 claims 或
// checkFeaturePerm ——middleware 页面挡板 + API 路由内 requireAdmin 双层结构中，
// 本函数只服务前者；验签缺失时宁可返回 undefined（fail-close）。
export function decodePermissionsClaim(token: string | undefined): { permissions?: string[] } | undefined {
  if (!token) return undefined;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const payload = JSON.parse(json) as { permissions?: unknown };
    if (Array.isArray(payload.permissions)) {
      return { permissions: payload.permissions.filter((p): p is string => typeof p === 'string') };
    }
    return {};
  } catch {
    return undefined;
  }
}
