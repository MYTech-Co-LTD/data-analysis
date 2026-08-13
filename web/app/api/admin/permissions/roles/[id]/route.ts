// web/app/api/admin/permissions/roles/[id]/route.ts
// PUT 角色：可只传部分字段——涉及参数写 roles，涉及默认范围写 data_permissions(subject_type='role') 行；
// 范围整行 null → 删行；写审计（update_role）。
// 写路径铁律：先写 roles/data_permissions，全部写成功后才落审计；任一写失败 → 502 透传且不写审计。
// 范围维语义（NIT-1）：字段显式出现（"k in body"）→ 直写该值（null = 清空该维，写入 NULL 不参与合成）；
//   未出现的字段保留旧值（PATCH 需整行替换，故合并旧行）；四维全 null（显式）→ 整行删（恢复无默认范围）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit } from '@/lib/permission-audit';
import { normArr, arrOrNull, canSeeCostOk } from '@/lib/permission-guards';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

type RouteCtx = { params: Promise<{ id: string }> };

const SCOPE_KEYS = ['branch_nums', 'brands', 'categories', 'can_see_cost'] as const;

// PUT /roles/:id
export async function PUT(req: NextRequest, { params }: RouteCtx) {
  const deny = requireAdmin(req); if (deny) return deny;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 }); // F7：非整数/非正 id 拒绝
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });

  // F6/F4：数组维校验提前（400 快捷失败，不读库；merged 复用下方 norms）
  const norms = {
    branch_nums: 'branch_nums' in b ? normArr(b.branch_nums) : undefined,
    brands: 'brands' in b ? normArr(b.brands) : undefined,
    categories: 'categories' in b ? normArr(b.categories) : undefined,
  };
  if (norms.branch_nums?.status === 'bad' || norms.brands?.status === 'bad' || norms.categories?.status === 'bad')
    return NextResponse.json({ ok: false, error: 'branch_nums/brands/categories 须为字符串数组' }, { status: 400 });
  if ('can_see_cost' in b && !canSeeCostOk(b.can_see_cost))
    return NextResponse.json({ ok: false, error: 'can_see_cost 须为布尔或 null' }, { status: 400 });

  // 先读旧值（审计）
  const [oldRole, oldPerm] = await Promise.all([
    fetch(`${POSTGREST_URL}/roles?select=code,name,default_landing,default_metric,visible_panels,is_active&id=eq.${id}`, { headers: H }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost&subject_type=eq.role&subject_id=eq.${id}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []),
  ]);
  const oldRoleArr = Array.isArray(oldRole) ? oldRole : [];
  const oldPermArr = Array.isArray(oldPerm) ? oldPerm : [];
  const oldRoleRow = oldRoleArr[0] ?? null;
  const oldPermRow = oldPermArr[0] ?? null;

  // F7：角色须存在才允许写（防幽灵 role 权限行指向不存在的角色）
  if (!oldRoleRow) return NextResponse.json({ ok: false, error: '角色不存在' }, { status: 404 });

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

  // 2) 默认范围：任一范围字段提供 → upsert role 行（显式字段直写 incl. null 清空；未出现字段保留旧值；整行 null → DELETE）
  let merged: Record<string, unknown> | null = null;
  if (SCOPE_KEYS.some(k => k in b)) {
    // F6/F4 已在上面校验；此处用提前算好的 norms 组装 merged（显式空数组 == 清空该维）
    merged = {
      branch_nums: 'branch_nums' in b ? arrOrNull(norms.branch_nums) : oldPermRow?.branch_nums ?? null,
      brands: 'brands' in b ? arrOrNull(norms.brands) : oldPermRow?.brands ?? null,
      categories: 'categories' in b ? arrOrNull(norms.categories) : oldPermRow?.categories ?? null,
      can_see_cost: 'can_see_cost' in b ? b.can_see_cost : oldPermRow?.can_see_cost ?? null,
    };
    const allNull = Object.values(merged).every(v => v === null);
    if (allNull && oldPermArr.length) {
      // 整行清空 → 删行（恢复「无默认范围」）；删失败 502 且不写审计（F2）
      const dr = await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPermRow.id}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      if (!dr.ok) return NextResponse.json({ ok: false, error: await dr.text() }, { status: 502 });
    } else if (!allNull) {
      const body = { subject_type: 'role', subject_id: String(id), ...merged, note: '角色tab修改' };
      const wr = oldPermArr.length
        ? await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPermRow.id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...merged, note: body.note }) })
        : await fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
      if (!wr.ok) return NextResponse.json({ ok: false, error: await wr.text() }, { status: 502 }); // F2：PATCH/POST 失败 502 且不写审计
    }
  }

  // 3) 审计：after = 实际写入的 JSON，仅含请求中出现的字段（rolePatch + 出现的范围维及写入值）（F3/NIT-1）
  const after: Record<string, unknown> = { ...rolePatch };
  if (merged) {
    for (const k of SCOPE_KEYS) if (k in b) after[k] = merged[k];
  }
  await writeAudit(req, { action: 'update_role', subjectType: 'role', subjectId: String(id), before: { role: oldRoleRow, perm: oldPermRow }, after });
  return NextResponse.json({ ok: true });
}
