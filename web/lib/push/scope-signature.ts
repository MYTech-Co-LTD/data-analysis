/**
 * scope 签名模块
 *
 * 契约来源：spec §5.2a
 * - 四维 canonical JSON：brands, branch_nums, categories, can_see_cost
 * - LC_ALL=C 排序（字节序）
 * - '*' 保留（不展开）
 * - 签名用途：同一 scope 的收件人分到同组，渲染一次发多人
 */

export interface Scope {
  brands?: string[];
  branch_nums?: string[];
  categories?: string[];
  can_see_cost?: boolean;
}

/**
 * 生成 scope 签名
 *
 * 规则：
 * 1. 每维按 LC_ALL=C 排序（字节序，即 Array.sort() 默认）
 * 2. '*' 保留原样
 * 3. can_see_cost 布尔值直接参与
 * 4. 签名 = JSON.stringify({b, br, c, cost})
 */
export function scopeSignature(scope: Scope): string {
  const canonical = {
    b: scope.brands ? [...scope.brands].sort() : undefined,
    br: scope.branch_nums ? [...scope.branch_nums].sort() : undefined,
    c: scope.categories ? [...scope.categories].sort() : undefined,
    cost: scope.can_see_cost ?? undefined,
  };

  // 去掉 undefined 字段（JSON.stringify 会忽略）
  return JSON.stringify(canonical);
}

/**
 * 比较两个 scope 是否等价
 */
export function scopeEqual(a: Scope, b: Scope): boolean {
  return scopeSignature(a) === scopeSignature(b);
}
