// web/app/api/admin/permissions/users/[wecom_id]/route.ts
// 个人 override 行：GET 详情 / PUT upsert（null=未配；全 null → 删行恢复继承）/ DELETE 删行。
// 167 迁移后个人授权在 data_permissions(subject_type='user')，get_user_perms 按「该维配了才覆盖」合成。
// 写路径：先写权限表，成功后再落审计；审计失败仅记日志不阻断。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

type RouteCtx = { params: Promise<{ wecom_id: string }> };

// GET /users/:wecom_id → { user, override|null }
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent((await params).wecom_id);
  const [userArr, over] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name&wecom_id=eq.${encodeURIComponent(w)}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
  ]);
  const u = Array.isArray(userArr) ? userArr : [];
  const o = Array.isArray(over) ? over : [];
  return NextResponse.json({ user: u[0] ?? null, override: o.length ? o[o.length - 1] : null });
}

// PUT /users/:wecom_id：权威替换该 user 的 override（null=未配；全 null → 删行恢复继承）
export async function PUT(req: NextRequest, { params }: RouteCtx) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent((await params).wecom_id);
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });
  const has = (b.branch_nums ?? null) !== null || (b.brands ?? null) !== null
    || (b.categories ?? null) !== null || (b.can_see_cost ?? null) !== null;

  // 读旧值（审计用）
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  const last = oldArr[oldArr.length - 1] ?? null;

  if (!has) {
    // 全 null → 删除（恢复继承）
    if (oldArr.length) {
      await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${oldArr.map((x: { id: number }) => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: last, after: null });
    }
    return NextResponse.json({ ok: true });
  }
  const body = {
    subject_type: 'user', subject_id: w, note: b.note ?? null,
    branch_nums: b.branch_nums ?? null, brands: b.brands ?? null,
    categories: b.categories ?? null, can_see_cost: b.can_see_cost ?? null,
    expires_at: b.expires_at ?? null,
  };
  const r = await (oldArr.length
    ? fetch(`${POSTGREST_URL}/data_permissions?id=eq.${(last as { id: number }).id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...body, subject_type: undefined, subject_id: undefined }) })
    : fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, { action: 'upsert_data_permission', subjectType: 'user', subjectId: w, before: last, after: body });
  return NextResponse.json({ ok: true });
}

// DELETE /users/:wecom_id：删全部该 user 的 override 行（恢复角色∪部门继承）
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent((await params).wecom_id);
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  if (oldArr.length) {
    await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${oldArr.map((x: { id: number }) => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  }
  await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: oldArr[oldArr.length - 1] ?? null, after: null });
  return NextResponse.json({ ok: true });
}
