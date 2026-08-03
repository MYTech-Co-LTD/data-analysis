// web/app/api/admin/permissions/preview/route.ts
// 生效权限预览：get_user_perms 合成结果 + 角色/部门/个人 override 各层来源（排障用）
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const wecomId = req.nextUrl.searchParams.get('wecom_id');
  if (!wecomId) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });

  const [permsRes, userArr] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_user_perms`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_wecom_id: wecomId }),
    }).then(r => r.json()).catch(() => null),
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,role_id,role_source,department_ids&wecom_id=eq.${encodeURIComponent(wecomId)}`, { headers: H, cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
  ]);
  const user = Array.isArray(userArr) ? userArr[0] ?? null : null;

  const roleArr = user?.role_id
    ? await fetch(`${POSTGREST_URL}/roles?select=id,code,name&id=eq.${user.role_id}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => [])
    : [];
  const deptIds: string[] = Array.isArray(user?.department_ids) ? user.department_ids : [];
  const depts = deptIds.length
    ? await fetch(`${POSTGREST_URL}/org_departments?select=id,name,branch_nums,can_see_cost&id=in.(${deptIds.map(x => `"${x}"`).join(',')})`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => [])
    : [];
  // data_permissions 无 RLS（072 设计：仅 SECURITY DEFINER 可读）；此处用 service key 直查（admin 已鉴权）
  const subjectFilter = `or=(and(subject_type.eq.user,subject_id.eq.${encodeURIComponent(wecomId)}),and(subject_type.eq.role,subject_id.eq.${user?.role_id ?? -1}))`;
  const perms = await fetch(`${POSTGREST_URL}/data_permissions?select=subject_type,subject_id,branch_nums,brands,categories,can_see_cost,expires_at,note&${subjectFilter}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []);

  return NextResponse.json({
    effective: permsRes,
    layers: { user, role: roleArr?.[0] ?? null, departments: depts, permissions: perms },
  });
}
