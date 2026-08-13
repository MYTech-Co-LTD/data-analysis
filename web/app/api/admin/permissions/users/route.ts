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
export async function PUT(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.wecom_id) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });
  const roleId = b.role_id ?? null;
  // 读旧值（审计用）
  const old = await fetch(`${POSTGREST_URL}/org_users?select=role_id,role_source&wecom_id=eq.${encodeURIComponent(b.wecom_id)}`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  const before = oldArr[0] ?? null;
  const r = await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(b.wecom_id)}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ role_id: roleId, role_source: roleId ? 'manual' : 'auto' }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, {
    action: 'assign_role', subjectType: 'user', subjectId: b.wecom_id,
    before, after: { wecom_id: b.wecom_id, role_id: roleId, role_source: roleId ? 'manual' : 'auto' },
  });
  return NextResponse.json({ ok: true });
}
