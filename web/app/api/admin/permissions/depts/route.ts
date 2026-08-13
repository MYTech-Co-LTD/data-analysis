// web/app/api/admin/permissions/depts/route.ts
// 部门权限：GET 部门列表（基础字段 + dept 权限行聚合 + dept_role_mapping 自动角色）；
// PUT 写部门 branch_nums/can_see_cost（upsert dept 行；brands/categories 恒 NULL；写审计）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET：部门 + dept 权限行 + 自动角色（dept_role_mapping）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const [d, p, m, r] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_departments?select=id,name,parent_id,is_active&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/dept_role_mapping?select=dept_id,role_id`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/roles?select=id,code,name`, { headers: H, cache: 'no-store' }),
  ]);
  const [depts, deptPerms, mappings, roles] = await Promise.all([d.json(), p.json(), m.json(), r.json()]);
  const roleName = new Map((Array.isArray(roles) ? roles : []).map((rr: { id: number; name: string }) => [rr.id, rr.name]));
  const deptPermArr = Array.isArray(deptPerms) ? deptPerms : [];
  const mappingArr = Array.isArray(mappings) ? mappings : [];
  const departments = (Array.isArray(depts) ? depts : []).map((dd: { id: string }) => {
    const dp = deptPermArr.find((x: { subject_id: string }) => x.subject_id === dd.id);
    const mp = mappingArr.find((x: { dept_id: string }) => x.dept_id === dd.id);
    return {
      ...dd,
      branch_nums: dp?.branch_nums ?? null,
      can_see_cost: dp?.can_see_cost ?? null,
      auto_role_id: mp?.role_id ?? null,
      auto_role_name: mp ? roleName.get(mp.role_id) ?? null : null,
    };
  });
  return NextResponse.json({ departments });
}

// PUT { id, branch_nums?, can_see_cost? }：upsert dept 行（brands/categories 恒 NULL）
export async function PUT(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({ ok: false, error: '缺 id' }, { status: 400 });
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.dept&subject_id=eq.${encodeURIComponent(String(b.id))}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  const last = oldArr[oldArr.length - 1] ?? null;
  const body = { subject_type: 'dept', subject_id: String(b.id), branch_nums: b.branch_nums ?? null, brands: null, categories: null, can_see_cost: b.can_see_cost ?? null, note: '部门tab修改' };
  const r = await (oldArr.length
    ? fetch(`${POSTGREST_URL}/data_permissions?id=eq.${(last as { id: number }).id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ branch_nums: body.branch_nums, can_see_cost: body.can_see_cost, note: body.note }) })
    : fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, { action: 'upsert_data_permission', subjectType: 'dept', subjectId: String(b.id), before: last, after: body });
  return NextResponse.json({ ok: true });
}
