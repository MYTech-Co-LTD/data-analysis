// web/app/api/admin/permissions/roles/[id]/route.ts
// PUT 角色：可只传部分字段——涉及参数写 roles，涉及默认范围写 data_permissions(subject_type='role') 行；
// 范围整行 null → 删行；写审计（update_role）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

type RouteCtx = { params: Promise<{ id: string }> };

// PUT /roles/:id
export async function PUT(req: NextRequest, { params }: RouteCtx) {
  const deny = requireAdmin(req); if (deny) return deny;
  const id = Number((await params).id); if (!id) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });
  // 先读旧值（审计）
  const [oldRole, oldPerm] = await Promise.all([
    fetch(`${POSTGREST_URL}/roles?select=code,name,default_landing,default_metric,visible_panels,is_active&id=eq.${id}`, { headers: H }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost&subject_type=eq.role&subject_id=eq.${id}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []),
  ]);
  const oldRoleArr = Array.isArray(oldRole) ? oldRole : [];
  const oldPermArr = Array.isArray(oldPerm) ? oldPerm : [];
  const oldRoleRow = oldRoleArr[0] ?? null;
  const oldPermRow = oldPermArr[0] ?? null;

  // 1) roles 参数（只 patch 提供的字段）
  const rolePatch: Record<string, unknown> = {};
  if ('default_landing' in b) rolePatch.default_landing = b.default_landing;
  if ('default_metric' in b) rolePatch.default_metric = b.default_metric;
  if ('visible_panels' in b) rolePatch.visible_panels = b.visible_panels;
  if ('is_active' in b) rolePatch.is_active = b.is_active;
  if (Object.keys(rolePatch).length) {
    const rr = await fetch(`${POSTGREST_URL}/roles?id=eq.${id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rolePatch) });
    if (!rr.ok) return NextResponse.json({ ok: false, error: await rr.text() }, { status: 502 });
  }
  // 2) 默认范围：任一范围字段提供 → upsert role 行（未提供的范围维 = 旧值合并或 NULL；整行为 null → DELETE）
  if (['branch_nums', 'brands', 'categories', 'can_see_cost'].some(k => k in b)) {
    const merged = {
      branch_nums: b.branch_nums ?? oldPermRow?.branch_nums ?? null,
      brands: b.brands ?? oldPermRow?.brands ?? null,
      categories: b.categories ?? oldPermRow?.categories ?? null,
      can_see_cost: b.can_see_cost ?? oldPermRow?.can_see_cost ?? null,
    };
    const allNull = Object.values(merged).every(v => v === null);
    if (allNull && oldPermArr.length) {
      await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPermRow.id}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
    } else if (!allNull) {
      const body = { subject_type: 'role', subject_id: String(id), ...merged, note: '角色tab修改' };
      if (oldPermArr.length) {
        await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPermRow.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...merged, note: body.note }) });
      } else {
        await fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
      }
    }
  }
  await writeAudit(req, { action: 'update_role', subjectType: 'role', subjectId: String(id), before: { role: oldRoleRow, perm: oldPermRow }, after: b });
  return NextResponse.json({ ok: true });
}
