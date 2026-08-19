/**
 * scope 签名模块
 *
 * 契约来源：spec §5.2a + M6/spec-forge
 * - 四维 canonical JSON：brands, branch_nums, categories, can_see_cost
 * - LC_ALL=C 排序（字节序）
 * - '*' 保留（不展开）
 * - 签名用途：同一 scope 的收件人分到同组，渲染一次发多人
 * - M6：读路径改 data_scope.* + fields.cost（Perms 新形状）；签名必须基于实际渲染 scope，
 *   否则不同门店集用户签名碰撞 → 同组用首用户 scope 渲染全员（跨用户泄漏）
 */
import type { Perms } from './push-variables';

/**
 * 生成 scope 签名
 *
 * 规则：
 * 1. 每维按 LC_ALL=C 排序（字节序，即 Array.sort() 默认）
 * 2. '*' 保留原样
 * 3. can_see_cost 布尔值直接参与
 * 4. 签名 = JSON.stringify({b, br, c, cost})
 */
export function scopeSignature(scope: Perms): string {
  const canonical = {
    b: scope.data_scope?.brands?.length ? [...scope.data_scope.brands].sort() : undefined,
    br: scope.data_scope?.branch_nums?.length ? [...scope.data_scope.branch_nums].sort() : undefined,
    c: scope.data_scope?.categories?.length ? [...scope.data_scope.categories].sort() : undefined,
    cost: scope.fields?.cost ?? undefined,
    // 异种 review #10：departments 入签名——同 data_scope 不同 department_ids 不得同组，
    // 防组内首用户 departments 写入全组代签 JWT 的跨用户 claim 泄漏（目标视图若读 departments RLS 则错配）
    dept: scope.departments?.length ? [...scope.departments].sort() : undefined,
  };

  // 去掉 undefined 字段（JSON.stringify 会忽略）
  return JSON.stringify(canonical);
}

/**
 * 比较两个 scope 是否等价
 */
export function scopeEqual(a: Perms, b: Perms): boolean {
  return scopeSignature(a) === scopeSignature(b);
}

// 兼容导出（旧 import 路径：engine.ts `Scope`）；指向 Perms 新形状
export type Scope = Perms;
