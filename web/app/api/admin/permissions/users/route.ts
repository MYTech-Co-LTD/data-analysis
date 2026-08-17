// web/app/api/admin/permissions/users/route.ts
// 权限管理：用户列表（例外表单用户选择器数据源，2026-08-17 收口版仅剩 GET）。
// 旧 PUT 角色指派 / [wecom_id] 四维 override / depts / roles 路由已随 data_permissions
// 表删除（185 sunset）下线——权限真相源 = Casdoor，例外 = /grants（避免误导，用户裁决）。
// ⚠️ gateway(7130) 不代理 /rpc 与表接口按既有 admin 路由模式直连 PostgREST
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET: 用户 + 角色 + 部门（页面一次性取齐；部门权限从 data_permissions 聚合）
export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const [u, r, d, p] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids,role_id,role_source&is_active=eq.true&order=name`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/roles?select=id,code,name&is_active=eq.true&order=sort_order`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/org_departments?select=id,name,parent_id,is_active&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept`, { headers: H, cache: 'no-store' }),
  ]);
  const [users, roles, depts, deptPerms] = await Promise.all([
    u.json().catch(() => []), r.json().catch(() => []),
    d.json().catch(() => []), p.json().catch(() => []),
  ]);
  const deptPermArr = Array.isArray(deptPerms) ? deptPerms : [];
  const departments = (Array.isArray(depts) ? depts : []).map((dd: { id: string }) => {
    const dp = deptPermArr.find((x: { subject_id: string }) => x.subject_id === dd.id);
    return { ...dd, branch_nums: dp?.branch_nums ?? null, can_see_cost: dp?.can_see_cost ?? null };
  });
  return NextResponse.json({
    users: Array.isArray(users) ? users : [],
    roles: Array.isArray(roles) ? roles : [],
    departments,
  });
}

