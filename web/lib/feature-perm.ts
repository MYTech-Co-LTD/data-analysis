// web/lib/feature-perm.ts
// 功能门禁单模块收口（spec §6.2 / plan Task 3，P0a）：
// 禁止散落 `userid === '...'` 式判断——所有功能级授权统一走 checkFeaturePerm，
// 后续切 casbin 是 1 处切换而非 N 处 hunt-and-replace。
// P0a 判定链：token claims 命中 → true；BREAKGLASS_ADMINS env 命中 → true（记审计）；
// 两者皆无 → false（fail-close）。BREAKGLASS 默认空 = 兜底关闭。
import { CATALOG_KEYS, DEPRECATED_KEYS, DISPLAY_NAME_TO_KEY } from './capability-catalog';
import { expandViewGroups } from './view-groups';
import {
  BOARD_CAPABILITY_BY_KEY,
  KPI_CARD_CAPABILITY_BY_KEY,
  BOARD_VIEW_COVERAGE,
} from './capability-board';

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
// 2026-08-17 离职四 sink①（web API 面即时收权）：附带解出 sub——middleware
// 软校验 is_active / blacklist by sub 用，缺 sub 不参与判定（软门禁保守放行）。
export interface DecodedClaims {
  permissions?: string[];
  catalog_v?: string;
  iat?: number;
  sub?: string;
}

export function decodePermissionsClaim(token: string | undefined): DecodedClaims | undefined {
  if (!token) return undefined;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const payload = JSON.parse(json) as { permissions?: unknown; catalog_v?: unknown; iat?: unknown; sub?: unknown };
    const out: DecodedClaims = {};
    if (Array.isArray(payload.permissions)) {
      out.permissions = payload.permissions.filter((p): p is string => typeof p === 'string');
    }
    if (typeof payload.catalog_v === 'string') out.catalog_v = payload.catalog_v;
    if (typeof payload.iat === 'number') out.iat = payload.iat;
    if (typeof payload.sub === 'string') out.sub = payload.sub;
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

// ============ 看板级 / KPI 卡片级能力判定（用户要求：每个看板/KPI 卡抽象成能力，自由配给角色） ============
// 命名空间：data-analysis:view-board:<id>（看板层）+ data-analysis:view-kpi:<code>（KPI 卡片层）。
// 判定语义（默认全开，用户 2026-08-17 拍板「避免上线即收权」）：
//   - claims.permissions 命中具名 key → true
//   - 命中命名空间通配（view-board:* / view-kpi:* / 全局 *）→ true（放行整类）
//   - claims.permissions 不含任何该命名空间能力（未配置/旧 token/无登录）→ **全开**（fail-open：
//     能力自由配置 = 只裁剪「明确配置了部分能力」的角色；未配置保持现状不主动收权）
//   - 仅当该命名空间有「部分具名配置」且当前 key 不在其中 → false（收权：只显配置的）
// 依赖单真相（capability-board.ts）做合法 key 校验：key 不存在于单真相 → false（防御未知 key）。
// 安全说明：显示层过滤为软门禁（fail-open 默认放行），真实数据安全由 PostgREST RLS 按门店范围
// 裁剪兜底；本函数只负责「看板/卡片可见性」这一展示层配置。

/** 判定池里是否含某命名空间下任意能力（有任意具名/通配 = 该命名空间已「配置化」，可裁剪） */
function namespaceConfigured(pool: ReadonlySet<string>, prefix: string): boolean {
  for (const k of pool) if (k === prefix + '*') return true;
  for (const k of pool) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * 判定池：把 perms 中的组|label 展示名还原为能力 key（方案甲：Casdoor 下拉选中组|label 写进
 *  permission.resources 后，claims/前端收到的权限串里可能直接是组|label 展示名——判定前统一归一回 key）。
 * 方案 C 扩展：① 全量组|label 展示名（catalog DISPLAY_NAME_TO_KEY，覆盖 view 与
 *  brand/category/field/admin/view-group 等命名空间 + 看板/KPI——catalog 已含 board/KPI 条目的 label）；
 *  ② 看板能力 → 覆盖的底层报表视图 key 注入（报表授权 ⇒ 视图访问，BOARD_VIEW_COVERAGE）。
 * 实现顺序：反查（组|label→key）→ 组展开 → 看板覆盖注入。
 */
export function buildPermPool(perms: readonly string[] | undefined): Set<string> {
  const src = perms ?? [];
  // 1) 展示名（组|label）→ key 全量反查（含组展示名「看板|报表看板全组」→ 组 key；看板展示名 → view-board:<id>）
  const keys = src.map((p) => DISPLAY_NAME_TO_KEY.get(p) ?? p);
  // 2) view-group 展开（组 key → 成员 view:* key）；已具名/未知名原样保留
  const pool = new Set(expandViewGroups(keys));
  // 3) 看板授权 ⇒ 覆盖报表视图授权（BOARD_CAPABILITY_BY_KEY：从归一后 key 找看板定义）
  for (const k of keys) {
    const b = BOARD_CAPABILITY_BY_KEY.get(k);
    if (b) for (const v of BOARD_VIEW_COVERAGE.get(b.id) ?? []) pool.add(`data-analysis:view:${v}`);
  }
  return pool;
}

/** 看板级能力：用户能否看到某个看板模块（boardId = BOARDS registry id，如 'kpi'/'region'） */
export function hasBoardPerm(perms: readonly string[] | undefined, boardId: string): boolean {
  if (!perms) return true;                                               // 无权限信息（未登录/缺省）→ 全开
  const key = `data-analysis:view-board:${boardId}`;
  if (!BOARD_CAPABILITY_BY_KEY.has(key)) return false;                  // 未知 boardId（防御）
  const pool = buildPermPool(perms);
  if (pool.has(key)) return true;
  if (pool.has('data-analysis:view-board:*')) return true;              // 命名空间通配
  if (pool.has('*')) return true;                                       // 全局通配
  if (!namespaceConfigured(pool, 'data-analysis:view-board:')) return true; // 未配置任何看板能力 → 全开
  return false;                                                         // 已配置化但此看板不在 → 收权
}

/** KPI 卡片级能力：用户能否看到某个 KPI 指标卡（code = metric_code 或派生比率卡 key，如 'sale'/'outbound_margin'） */
export function hasKpiPerm(perms: readonly string[] | undefined, code: string): boolean {
  if (!perms) return true;                                              // 无权限信息（未登录/缺省）→ 全开
  const key = `data-analysis:view-kpi:${code}`;
  if (!KPI_CARD_CAPABILITY_BY_KEY.has(key)) return false;               // 未知 code（防御）
  const pool = buildPermPool(perms);
  if (pool.has(key)) return true;
  if (pool.has('data-analysis:view-kpi:*')) return true;                // 命名空间通配
  if (pool.has('*')) return true;                                       // 全局通配
  if (!namespaceConfigured(pool, 'data-analysis:view-kpi:')) return true; // 未配置任何 KPI 能力 → 全开
  return false;                                                         // 已配置化但此卡不在 → 收权
}
