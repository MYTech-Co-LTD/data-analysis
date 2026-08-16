// web/app/api/admin/permissions/users/route.ts
// 权限管理：用户列表（含角色）+ 角色指派（manual）/ 恢复自动（auto）
// 167 迁移后 org_departments 已无权限列：部门列表的 branch_nums/can_see_cost 从
// data_permissions(subject_type='dept') 行聚合（未配置 → null）。
// ⚠️ gateway(7130) 不代理 /rpc 与表接口按既有 admin 路由模式直连 PostgREST
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';

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

// PUT: 指派角色 { wecom_id, role_id }；role_id=null -> 恢复自动（role_source='auto'，下次同步重算）
// F4：org_users PATCH 成功后才落 assign_role 审计（actor 由 writeAudit 从 cookie 取）。
//
// Task 12 写者收编（spec §4.5a）：U1 起 role 字段冻结，页面 role 区只读+引导文案。
// 四维 override 不受影响（由 /users/[wecom_id] route 处理）。
// 冻结原因：角色管理已迁移到 Casdoor，本地 role_id 由薄同步 auto 推导，不再接受手动指派。
export async function PUT(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.wecom_id) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });

  // Task 12: role 字段冻结——返回 409 + 引导文案
  if ('role_id' in b) {
    return NextResponse.json({
      ok: false,
      error: 'role_frozen',
      message: '角色管理已迁移至统一身份平台（Casdoor）。请在 Casdoor 中配置用户角色，系统会通过薄同步自动同步到本地。如需紧急调整，请联系管理员。',
      casdoor_url: process.env.CASDOOR_DASHBOARD_URL || 'https://sso.shanhaiyiguo.com',
    }, { status: 409 });
  }

  return NextResponse.json({ ok: true, message: '无变更（role 字段已冻结，四维 override 请通过 /users/:wecom_id 路由操作）' });
}
