// web/lib/validate-capabilities.ts
// 校验器（spec §5.1 ⑤）：只认 catalog ∪ "*"（∪ deprecated——deprecated 是「拒绝+告警」不是放行）。
import { CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS } from './capability-catalog';

export type KeyVerdict = { ok: true } | { ok: false; reason: 'unknown' | 'deprecated' };

export function validateKey(key: string): KeyVerdict {
  if (key === '*') return { ok: true };
  if (DEPRECATED_KEYS.has(key)) return { ok: false, reason: 'deprecated' };
  if (CATALOG_KEYS.has(key)) return { ok: true };
  return { ok: false, reason: 'unknown' };
}

const WILDCARD_RE = /^data-analysis:(view|view-group|brand|category|field):\*$/;
export function validateWildcardRisk(perms: readonly string[]): { risky: readonly string[] } {
  return { risky: perms.filter((p) => WILDCARD_RE.test(p)) };
}

// 环引用检测（S1）：view-group 嵌套 A→B→A 展开死循环 = 登录链路卡死
export function detectViewGroupCycle(groups: Record<string, { members: readonly string[] }> = VIEW_GROUPS as never): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cyclic: string[] = [];
  const visit = (node: string, stack: string[]): void => {
    const c = color.get(node) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) { cyclic.push(...stack.slice(stack.indexOf(node))); return; }
    color.set(node, GRAY);
    for (const m of groups[node]?.members ?? [])
      if (m in groups) visit(m, [...stack, node]);   // 只沿 view-group→view-group 边走
    color.set(node, BLACK);
  };
  for (const g of Object.keys(groups)) visit(g, []);
  return [...new Set(cyclic)];
}
