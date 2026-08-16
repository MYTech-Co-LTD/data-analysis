// services/semantic-generator/src/generators/perm.ts
/**
 * 行级权限过滤（架构 §10.10「权限过滤」扩展，2026-08-03）
 *
 * 与 maskCost 列脱敏同属模板级横切安全能力：所有视图自动继承，
 * 禁在 view-configs / metric_registry 写权限逻辑（铁律第 6 条）。
 *
 * T19 B 项裁决（DW2 gate_2c6ebef04ea1）：行过滤切 scope_match_v2（迁移 179）——
 * 与 RLS 行级策略同源判定函数，视图层/行级口径一致（形状鉴别：claims.data_scope
 * 存在 → 只认之，空段=deny B1；缺失 → 回退 072 旧语义宽松支，S4 豁免窗口）。
 *
 * 门店维双格式 OR（T12 先例，与 179 策略 2.1 同款）：
 *   · 裸 branch_num 支 = legacy 顶层 claims.branch_nums 值为裸门店号（015/046/058 现状语义保留）；
 *   · sbc || '-' || branch_num 支 = branch_number 全局唯一键（T11 data_scope 新形状，门店键铁律）。
 *   两支各自独立形状鉴别：新令牌裸支不命中（值域不同）、空集时两支同 deny，B1 不受 OR 稀释。
 * 门店键铁律：branch_num 不单独过滤，与 brands(system_book_code) 组合（品牌维 AND）。
 * claims 来源：scope_match_v2 内部自读 request.jwt.claims 整体 GUC（不依赖 114 扁平化）。
 */

/** actual CTE（fact 表）行过滤：品牌 + 门店双维度
 *  skipBranch=true 时仅过滤品牌（item 粒度聚合表无 branch_num 列） */
export function permFilterFact(alias: string, skipBranch = false): string {
  const brand = `scope_match_v2('brands', ${alias}.system_book_code)`;
  if (skipBranch) return brand;
  const branchBare = `scope_match_v2('branch_nums', ${alias}.branch_num::text)`;
  const branchGlobal = `scope_match_v2('branch_nums', ${alias}.system_book_code || '-' || ${alias}.branch_num)`;
  return `${brand} AND (${branchBare} OR ${branchGlobal})`;
}

/** targets CTE 行过滤：'ALL' 汇总行（总部/总目标）恒可见，门店行按 claim 过滤 */
export function permFilterTarget(alias: string): string {
  return `(${alias}.branch_num = 'ALL' OR ${permFilterFact(alias)})`;
}

/** FULL JOIN 行过滤：两侧 COALESCE（report_daily_delivery d FULL JOIN report_daily_wholesale w
 *  等场景，d 或 w 侧可能 NULL，用 COALESCE 取非空侧值过滤） */
export function permFilterFullJoin(aliasA: string, aliasB: string): string {
  const brand = `scope_match_v2('brands', COALESCE(${aliasA}.system_book_code, ${aliasB}.system_book_code))`;
  const branchBare = `scope_match_v2('branch_nums', COALESCE(${aliasA}.branch_num, ${aliasB}.branch_num)::text)`;
  const branchGlobal = `scope_match_v2('branch_nums', COALESCE(${aliasA}.system_book_code, ${aliasB}.system_book_code) || '-' || COALESCE(${aliasA}.branch_num, ${aliasB}.branch_num))`;
  return `${brand} AND (${branchBare} OR ${branchGlobal})`;
}
