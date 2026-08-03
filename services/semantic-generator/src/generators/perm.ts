// services/semantic-generator/src/generators/perm.ts
/**
 * 行级权限过滤（架构 §10.10「权限过滤」扩展，2026-08-03）
 *
 * 与 maskCost 列脱敏同属模板级横切安全能力：所有视图自动继承，
 * 禁在 view-configs / metric_registry 写权限逻辑（铁律第 6 条）。
 *
 * 语义照迁移 072 ⑫：claim 缺失/空/含 "*" -> 放行（零爆炸半径，旧 token 不破坏）。
 * 门店键铁律：branch_num 不单独过滤，与 brands(system_book_code) 组合。
 * GUC 来源：迁移 114 pgrst_pre_request 把 JWT claims 扁平化为 request.jwt.claims.<key>。
 */

/** actual CTE（fact 表）行过滤：品牌 + 门店双维度
 *  skipBranch=true 时仅过滤品牌（item 粒度聚合表无 branch_num 列） */
export function permFilterFact(alias: string, skipBranch = false): string {
  const brand = `claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, ${alias}.system_book_code)`;
  if (skipBranch) return brand;
  return `${brand} AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, ${alias}.branch_num::text)`;
}

/** targets CTE 行过滤：'ALL' 汇总行（总部/总目标）恒可见，门店行按 claim 过滤 */
export function permFilterTarget(alias: string): string {
  return `(${alias}.branch_num = 'ALL' OR ${permFilterFact(alias)})`;
}
