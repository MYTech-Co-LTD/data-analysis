// web/lib/feature-perm.ts
// 功能门禁单模块收口（spec §6.2 / plan Task 3，P0a）：
// 禁止散落 `userid === '...'` 式判断——所有功能级授权统一走 checkFeaturePerm，
// 后续切 casbin 是 1 处切换而非 N 处 hunt-and-replace。
// P0a 判定链：token claims 命中 → true；BREAKGLASS_ADMINS env 命中 → true（记审计）；
// 两者皆无 → false（fail-close）。BREAKGLASS 默认空 = 兜底关闭。
import { CATALOG_KEYS, DEPRECATED_KEYS } from './capability-catalog';
import { expandViewGroups } from './view-groups';

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
// Task 13：附带解出 catalog_v / iat（middleware 的 S4 旧形状 48h TTL 判定用），
// 缺失字段不出现（typeof 守卫），旧调用方形状不变。
export interface DecodedClaims {
  permissions?: string[];
  catalog_v?: string;
  iat?: number;
}

export function decodePermissionsClaim(token: string | undefined): DecodedClaims | undefined {
  if (!token) return undefined;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const payload = JSON.parse(json) as { permissions?: unknown; catalog_v?: unknown; iat?: unknown };
    const out: DecodedClaims = {};
    if (Array.isArray(payload.permissions)) {
      out.permissions = payload.permissions.filter((p): p is string => typeof p === 'string');
    }
    if (typeof payload.catalog_v === 'string') out.catalog_v = payload.catalog_v;
    if (typeof payload.iat === 'number') out.iat = payload.iat;
    return out;
  } catch {
    return undefined;
  }
}

// catalog_v 校验（H6/M3.5/M2）——判定序与实查成 AND（F10）：本模块是离线快判层，
// 实查段（requireAdmin/casbin enforce）不因此跳过。
export interface CatalogVVerdict { fastPath: boolean; rejected: string[]; stale?: boolean }

export function catalogVCheck(claim: { catalog_v?: string; permissions?: readonly string[] }, serverV: string): CatalogVVerdict {
  const perms = claim.permissions ?? [];
  if (claim.catalog_v === serverV) return { fastPath: true, rejected: [] };   // 快路径：== 恒定真
  // 慢路径：逐 key ∈ catalog ∪ deprecated（deprecated 保留在「已知」集——驱逐 = 从两集都消失才拒）
  const rejected = perms.filter((k) => k !== '*' && !k.endsWith(':*') &&
    !CATALOG_KEYS.has(k) && !DEPRECATED_KEYS.has(k));
  return { fastPath: false, rejected, stale: claim.catalog_v === undefined }; // stale：旧形状令牌（S4 ≤48h 由调用方判 iat）
}

// 解析期校验（M2）：通配展开后的具体 key 仍须 ∈ catalog ∪ deprecated
// Task 19：pool 先经 expandViewGroups（view-group 组键递归展开为成员 view:* 键），
// 组持有者 = 成员视图持有者；named / wildcard 判定逻辑不变，只是查询池换掉。
export function resolveViewKey(perms: readonly string[], view: string): { ok: boolean; key?: string; reason?: 'unknown' | 'deprecated' } {
  const key = `data-analysis:view:${view}`;
  const pool = new Set(expandViewGroups(perms));
  const named = pool.has(key);
  const wildcard = pool.has('data-analysis:view:*') || pool.has('*');
  if (!named && !wildcard) return { ok: false, reason: 'unknown' };           // 无命中
  // 命中（具名或通配）→ 校验解析结果粒度
  if (DEPRECATED_KEYS.has(key)) return { ok: false, reason: 'deprecated' };
  if (!CATALOG_KEYS.has(key)) return { ok: false, reason: 'unknown' };        // ★M2：通配持有者对已驱逐 key 在此被挡
  return { ok: true, key };
}
