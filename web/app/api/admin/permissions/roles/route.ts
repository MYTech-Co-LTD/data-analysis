// web/app/api/admin/permissions/roles/route.ts
// 角色列表：roles（UI 参数）+ data_permissions(subject_type='role') 默认范围行聚合（未配置 → null）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET /roles：角色参数 + 角色默认范围（data_permissions subject_type='role'）
export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const [r, p] = await Promise.all([
    fetch(`${POSTGREST_URL}/roles?select=id,code,name,default_landing,default_metric,visible_panels,is_active&order=sort_order`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,brands,categories,can_see_cost&subject_type=eq.role`, { headers: H, cache: 'no-store' }),
  ]);
  const [roles, perms] = await Promise.all([r.json(), p.json()]);
  const permArr = Array.isArray(perms) ? perms : [];
  const roleArr = Array.isArray(roles) ? roles : [];
  return NextResponse.json({
    roles: roleArr.map((ro: { id: number }) => {
      const dp = permArr.find((x: { subject_id: string }) => x.subject_id === String(ro.id));
      return { ...ro, branch_nums: dp?.branch_nums ?? null, brands: dp?.brands ?? null, categories: dp?.categories ?? null, can_see_cost: dp?.can_see_cost ?? null };
    }),
  });
}
