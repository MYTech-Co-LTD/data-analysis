// web/app/api/admin/permissions/users/[wecom_id]/route.ts
// 个人 override 行：GET 详情 / PUT upsert（null=未配；全 null → 删行恢复继承）/ DELETE 删行。
// 167 迁移后个人授权在 data_permissions(subject_type='user')，get_user_perms 按「该维配了才覆盖」合成。
// 写路径铁律：先写权限表，写成功后才落审计；权限表写失败 → 502 透传且不写审计；审计失败仅记日志不阻断。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';
import { normArr, arrOrNull, canSeeCostOk, expiresAtOk } from '@/lib/permission-guards';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

type RouteCtx = { params: Promise<{ wecom_id: string }> };

// GET /users/:wecom_id → { user, override|null }
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const w = (await params).wecom_id; // Next 已解码，勿二次 decodeURIComponent（F6）
  const [userArr, over] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name&wecom_id=eq.${encodeURIComponent(w)}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
  ]);
  const u = Array.isArray(userArr) ? userArr : [];
  const o = Array.isArray(over) ? over : [];
  return NextResponse.json({ user: u[0] ?? null, override: o.length ? o[o.length - 1] : null });
}

// PUT /users/:wecom_id：权威替换该 user 的 override（null=未配；全 null → 删行恢复继承）
// 注意：has 只算四维（branch_nums/brands/categories/can_see_cost）；仅传 note/expires_at 且四维全 null
// 视同「未配置」→ 删行（前端需全量提交 override）。
export async function PUT(req: NextRequest, { params }: RouteCtx) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const w = (await params).wecom_id;
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });

  // F6：数组维只收纯字符串数组，否则 400；F4：空数组 == 未配 → null
  const bn = normArr(b.branch_nums), br = normArr(b.brands), ct = normArr(b.categories);
  if (bn.status === 'bad' || br.status === 'bad' || ct.status === 'bad')
    return NextResponse.json({ ok: false, error: 'branch_nums/brands/categories 须为字符串数组' }, { status: 400 });
  if (!canSeeCostOk(b.can_see_cost) || !expiresAtOk(b.expires_at))
    return NextResponse.json({ ok: false, error: 'can_see_cost 须为布尔，expires_at 须为 ISO 字符串或 null' }, { status: 400 });

  const body = {
    subject_type: 'user', subject_id: w, note: b.note ?? null,
    branch_nums: arrOrNull(bn), brands: arrOrNull(br), categories: arrOrNull(ct),
    can_see_cost: b.can_see_cost === undefined || b.can_see_cost === null ? null : b.can_see_cost,
    expires_at: b.expires_at === undefined || b.expires_at === null ? null : b.expires_at,
  };
  const has = body.branch_nums !== null || body.brands !== null || body.categories !== null
    || body.can_see_cost !== null;

  // 存在性校验（review NIT #4）：用户须存在，否则 404（防为任意字符串建孤儿 override 行）
  const userRows = await fetch(`${POSTGREST_URL}/org_users?select=wecom_id&wecom_id=eq.${encodeURIComponent(w)}`, { headers: H }).then(r => r.json()).catch(() => []);
  if (!(Array.isArray(userRows) ? userRows : []).length)
    return NextResponse.json({ ok: false, error: '用户不存在，请先同步通讯录' }, { status: 404 });

  // 读旧值（审计用）
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  const last = oldArr[oldArr.length - 1] ?? null;

  if (!has) {
    // 全 null（含空数组规范化）→ 删除（恢复继承）；删失败 502 且不写审计（F1）
    if (oldArr.length) {
      const dr = await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${oldArr.map((x: { id: number }) => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      if (!dr.ok) return NextResponse.json({ ok: false, error: await dr.text() }, { status: 502 });
      await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: last, after: null });
    }
    return NextResponse.json({ ok: true });
  }
  const r = await (oldArr.length
    ? fetch(`${POSTGREST_URL}/data_permissions?id=eq.${(last as { id: number }).id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...body, subject_type: undefined, subject_id: undefined }) })
    : fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, { action: 'upsert_data_permission', subjectType: 'user', subjectId: w, before: last, after: body });
  return NextResponse.json({ ok: true });
}

// DELETE /users/:wecom_id：删全部该 user 的 override 行（恢复角色∪部门继承）；删失败 502 且不写审计（F1）
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const w = (await params).wecom_id;
  // 存在性校验（review NIT #4）：用户须存在，否则 404
  const userRows = await fetch(`${POSTGREST_URL}/org_users?select=wecom_id&wecom_id=eq.${encodeURIComponent(w)}`, { headers: H }).then(r => r.json()).catch(() => []);
  if (!(Array.isArray(userRows) ? userRows : []).length)
    return NextResponse.json({ ok: false, error: '用户不存在，请先同步通讯录' }, { status: 404 });
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const oldArr = Array.isArray(old) ? old : [];
  if (oldArr.length) {
    const dr = await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${oldArr.map((x: { id: number }) => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
    if (!dr.ok) return NextResponse.json({ ok: false, error: await dr.text() }, { status: 502 });
  }
  await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: oldArr[oldArr.length - 1] ?? null, after: null });
  return NextResponse.json({ ok: true });
}
