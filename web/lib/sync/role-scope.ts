// web/lib/sync/role-scope.ts
// 角色链资源解析 + 展示名归一（2026-08-18 三层模型强制）：
//   ① matchRolePermissions：只取 permission.roles 命中用户角色码的 permission resources 并集——
//      permission.users 直挂（roles=[]）与 permission.groups 挂载天然匹配不上 → 排除（任何来源写入直挂都不生效）。
//     与 functions/wecom-oidc-callback/claims.js matchRolePermissions 同语义（web 侧预览/对账同口径，防 function/web 侧漂移）。
//   ② normalizeFriendlyPerm：Casdoor 展示名（`组|label`，如「品牌|熊喵鲜生」）→ 能力 key（data-analysis:brand:3120），
//     经 catalog 单真相（capability-catalog.ts DISPLAY_NAME_TO_KEY）反查——**不内嵌静态表副本**（catalog 单真相纪律），
//     与 claims.js normalizeFriendlyPerm 的 FRIENDLY_TO_KEY 静态表对拍；范围|X 前缀规则（2026-08-18 门店范围显式授权）同款。
//   纯函数，无 I/O —— 契约测试 role-scope.test.ts 断言防回归。
import { DISPLAY_NAME_TO_KEY } from '../capability-catalog';

export interface CasdoorPermission {
  name?: string;
  roles?: readonly unknown[];
  users?: readonly unknown[];
  groups?: readonly unknown[];
  resources?: readonly unknown[];
}

// 角色链匹配（与 claims.js matchRolePermissions 逐句同语义）：只返回命中任一用户角色码的 permission resources 并集。
//   roles 全路径（'shanhai/manager'）vs 用户角色码裸名（'manager'）→ split('/').pop() 归一。
//   跨 permission 去重（Set 保持插入序）；null/undefined 入参 → 空数组（无角色即无授权，B1 空集 deny 载体）。
export function matchRolePermissions(
  perms: readonly CasdoorPermission[] | null | undefined,
  myRoleCodes: readonly (string | number)[] | null | undefined,
): string[] {
  const mine = new Set((myRoleCodes ?? []).map((r) => String(r)));
  const out = new Set<string>();
  for (const p of perms ?? []) {
    const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
    const hit = pr.some((r) => mine.has(r) || mine.has(r.split('/').pop() ?? ''));
    if (!hit) continue;
    for (const res of p.resources ?? []) if (typeof res === 'string') out.add(res);
  }
  return [...out];
}

// 展示名归一（与 claims.js normalizeFriendlyPerm 同语义，映射表改用 catalog DISPLAY_NAME_TO_KEY 单真相）：
//   `范围|X` → `data-analysis:branch:X`（X 原样透传：'*' / 包名 / branch_number / 门店中文名——388 店清单不进 catalog）；
//   已知展示名 → 能力 key；未命中/已归一 key 原样透传（登录 normalizeFriendlyPerm 同时接受两种形态）。
export function normalizeFriendlyPerm(value: string): string {
  if (value.startsWith('范围|')) {
    return 'data-analysis:branch:' + value.slice('范围|'.length);
  }
  return DISPLAY_NAME_TO_KEY.get(value) ?? value;
}
