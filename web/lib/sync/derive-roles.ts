// web/lib/sync/derive-roles.ts
// 角色推导单实现（spec §4.5a：dept_role_mapping→角色收进共享模块，refresh 与薄同步同调，禁双推导引擎）。
// 逻辑与 152 refresh_role_assignments() 逐行等价：部门名正则→角色码，多部门取 priority 最高，无匹配默认 manager。
// 推导结果仅供薄同步写 Casdoor 用（auto 用户），不直接写本地 role_id（那是 refresh RPC 的职责）。

import { POSTGREST_URL } from '../jobs/env';

const PG_H = (): Record<string, string> => {
  const KEY = process.env.INSFORGE_API_KEY!;
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
};

// ---- 部门名→角色码映射规则（与 152 migration 逐行一致） ----
// ⚠️ 锚定约束（review 讨论记录）：这些正则故意「不锚定」——152 refresh_role_assignments
// 用的是 PostgreSQL ~（contains 语义）同一组 pattern：/'(总经办|运营总|老板)'/ 等。
// 本文件与 152 必须逐行等价（禁双推导引擎）。若要做词边界/全串锚定收紧，
// 必须 152 SQL + 本文件 + dept_role_mapping 重算三处同步改（回归影响现网角色），
// 属设计变更，不在 P2 修复范围；此处只做 null 防护（与 SQL 的 d.name ~ 遇 NULL 不匹配等价）。
interface RoleMappingRule {
  pattern: RegExp;
  code: string;
  priority: number;
}

const MAPPING_RULES: RoleMappingRule[] = [
  { pattern: /(总经办|运营总|老板)/, code: 'boss', priority: 10 },
  { pattern: /(战区|区域|大区)/, code: 'zone_manager', priority: 1 },
  { pattern: /(店长|门店)/, code: 'manager', priority: 1 },
  { pattern: /(采购|业务|品类)/, code: 'buyer', priority: 1 },
  { pattern: /(财务)/, code: 'finance', priority: 1 },
];

const DEFAULT_ROLE_CODE = 'manager';

// in.() 值白名单+编码（与 push-contract B7 同款防护：部门 id 来自通讯录落库，
// 拼 PostgREST filter 前过滤非法字符并 URL 编码，防 filter 注入/查询语义被改）
// 合法（数字/字母/下划线连字符）id 全部通过，行为与 152 逐行等价；只拦肯定写坏的数据。
const DEPT_ID_RE = /^[A-Za-z0-9_-]+$/;
const buildDeptIdList = (ids: string[]): string =>
  ids.filter((id) => DEPT_ID_RE.test(id)).map(encodeURIComponent).join(',');

/** 按部门名推断角色码+优先级（无匹配返回 null；空名不匹配——与 152 SQL 遇 NULL 不命中等价） */
export function matchDeptToRole(deptName: string): { code: string; priority: number } | null {
  if (!deptName) return null;
  for (const rule of MAPPING_RULES) {
    if (rule.pattern.test(deptName)) {
      return { code: rule.code, priority: rule.priority };
    }
  }
  return null;
}

/** 单用户推导：从 department_ids 取部门名→匹配角色→取 priority 最高→返回角色码 */
export async function deriveRoleForUser(
  departmentIds: string[],
): Promise<string | null> {
  if (!departmentIds.length) return null;

  // 查部门名
  const deptIdList = buildDeptIdList(departmentIds);
  if (!deptIdList) return null;
  const depts: Array<{ id: string; name: string }> = await fetch(
    `${POSTGREST_URL}/org_departments?select=id,name&id=in.(${deptIdList})&is_active=eq.true`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  if (!depts.length) return null;

  // 逐部门匹配，取 priority 最高（同 priority 取 code 字典序最小，与 152 ORDER BY drm.priority DESC, drm.role_id 一致）
  let bestCode: string | null = null;
  let bestPriority = -1;

  for (const dept of depts) {
    const match = matchDeptToRole(dept.name);
    if (!match) continue;
    if (match.priority > bestPriority ||
        (match.priority === bestPriority && (bestCode === null || match.code < bestCode))) {
      bestCode = match.code;
      bestPriority = match.priority;
    }
  }

  return bestCode ?? DEFAULT_ROLE_CODE;
}

/** 批量推导所有 auto 用户的角色（供 drift 对比/outbox 批量写入） */
export interface DerivedRole {
  wecom_id: string;
  name: string | null;
  department_ids: string[];
  derived_code: string | null;
  current_role_id: number | null;
  current_role_source: string;
}

export async function deriveAllAutoRoles(): Promise<DerivedRole[]> {
  // 只拉 active + auto 用户
  const users: Array<{
    wecom_id: string; name: string | null;
    department_ids: string[]; role_id: number | null; role_source: string;
  }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids,role_id,role_source&is_active=eq.true&role_source=eq.auto`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  // 批量查部门名（一次请求取所有涉及的部门）
  const allDeptIds = [...new Set(users.flatMap(u => u.department_ids ?? []))];
  const deptMap = new Map<string, string>();
  if (allDeptIds.length) {
    const deptIdList = buildDeptIdList(allDeptIds);
    if (!deptIdList) return [];
    const depts: Array<{ id: string; name: string }> = await fetch(
      `${POSTGREST_URL}/org_departments?select=id,name&id=in.(${deptIdList})&is_active=eq.true`,
      { headers: PG_H(), cache: 'no-store' },
    ).then(r => r.json()).catch(() => []);
    for (const d of depts) deptMap.set(d.id, d.name);
  }

  return users.map(u => {
    const deptNames = (u.department_ids ?? []).map(id => deptMap.get(id)).filter(Boolean) as string[];
    let derivedCode: string | null = null;
    let bestPriority = -1;
    for (const name of deptNames) {
      const match = matchDeptToRole(name);
      if (!match) continue;
      if (match.priority > bestPriority ||
          (match.priority === bestPriority && (derivedCode === null || match.code < derivedCode))) {
        derivedCode = match.code;
        bestPriority = match.priority;
      }
    }
    if (derivedCode === null && deptNames.length > 0) derivedCode = DEFAULT_ROLE_CODE;
    return {
      wecom_id: u.wecom_id,
      name: u.name,
      department_ids: u.department_ids ?? [],
      derived_code: derivedCode,
      current_role_id: u.role_id,
      current_role_source: u.role_source,
    };
  });
}
