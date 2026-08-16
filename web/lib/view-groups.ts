// web/lib/view-groups.ts
// view-group 展开转正（spec §5.5）：映射在 catalog（app 侧），Casdoor 只见组名 resource。
// 嵌套支持；环由 visited-set 截断（防御）——准入在 Task 3 校验器（detectViewGroupCycle 红测）。
// M1：成员只允许具名 view:* key（通配兜底会自动扩权，validateViewGroupMembers 拒绝）。
// 生效粒度（S1）：成员变更 → catalog_v 版本戳变（CATALOG_V env 随部署 bump）→ 旧令牌
// 48h TTL 内强制刷新——机制即 Task 13 已落地的 catalog_v + iat 判定，不另建通道。
import { VIEW_GROUPS } from './capability-catalog';

type Groups = Record<string, { label: string; members: readonly string[] }>;
const groups = VIEW_GROUPS as unknown as Groups;

export function validateViewGroupMembers(g: Groups = groups): { offenders: string[] } {
  const offenders: string[] = [];
  for (const [name, def] of Object.entries(g))
    for (const m of def.members)
      if (m === '*' || m.endsWith(':*') || m === name) offenders.push(`${name} -> ${m}`);
  return { offenders };
}

export function expandViewGroups(perms: readonly string[], g: Groups = groups): string[] {
  const out = new Set<string>();
  const expand = (key: string, visited: Set<string>): void => {
    const def = g[key];
    if (!def) { out.add(key); return; }               // 非组键（含 view:* 具名/通配）原样保留
    if (visited.has(key)) {                           // 环防御（校验器准入外的兜底）
      console.error(`[view-groups] cycle detected at ${key} — 截断`);
      return;
    }
    const v2 = new Set(visited); v2.add(key);
    for (const m of def.members) expand(m, v2);
  };
  for (const p of perms) expand(p, new Set());
  return [...out];
}
