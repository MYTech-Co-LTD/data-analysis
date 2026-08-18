// web/app/api/admin/scope-tree/route.ts
// 2026-08-18 能力页「数据范围」版块数据：三级树 战区→二级区域→门店（dim_branch），
// 区域节点对 maps 包名（范围|<包名> 可直接授权）+ permissions 反查挂用人数。
// 门禁：requireAdmin；失败 503 带原因。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { casdoorFetch } from '@/lib/sync/casdoor-client';

export const dynamic = 'force-dynamic';

const PGRST = process.env.POSTGREST_URL || 'http://postgrest:3000';
const ORG = process.env.CASDOOR_ORG || 'shanhai';

export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;

  const pgrstGet = async (path: string) => {
    const r = await fetch(`${PGRST}${path}`, { headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  };

  let branches: Array<{ branch_number: string; branch_name: string; first_level_region: string; second_level_region: string }>;
  let maps: Array<{ group_id: string; branch_number: string }>;
  try {
    [branches, maps] = await Promise.all([
      pgrstGet('/dim_branch?select=branch_number,branch_name,first_level_region,second_level_region'),
      pgrstGet('/maps_branch_group?is_active=eq.true&select=group_id,branch_number'),
    ]);
  } catch (e) {
    return NextResponse.json({ error: 'postgrest_unavailable', detail: (e as Error).message }, { status: 503 });
  }

  // permissions 反查：范围|X → 挂用人数（scope permission resources）
  const permsRes = await casdoorFetch(`/api/get-permissions?owner=${encodeURIComponent(ORG)}`);
  const permCount = new Map<string, number>();
  if (permsRes.ok) {
    const list = (Array.isArray(permsRes.data) ? permsRes.data : (permsRes.data as { data?: unknown[] })?.data ?? []) as Array<{ users?: string[]; resources?: string[] }>;
    for (const p of list) {
      const users = (p.users ?? []).length;
      if (!users) continue;
      for (const r of p.resources ?? []) {
        if (String(r).startsWith('范围|')) permCount.set(String(r), (permCount.get(String(r)) ?? 0) + users);
      }
    }
  }

  // 包名集合（maps 去重 group_id）；区域名命中包名 → 可直接授权
  const packs = new Set(maps.map((m) => m.group_id));
  // 门店重名标注（登录解析 fail-close，须用编号）
  const nameCount = new Map<string, number>();
  for (const b of branches) nameCount.set(b.branch_name, (nameCount.get(b.branch_name) ?? 0) + 1);

  // 三级树
  const warZones = new Map<string, Map<string, Array<{ n: string; name: string; branchNumber: string; dup: boolean }>>>();
  for (const b of branches) {
    if (!b.first_level_region) continue;
    if (!warZones.has(b.first_level_region)) warZones.set(b.first_level_region, new Map());
    const regions = warZones.get(b.first_level_region)!;
    if (!regions.has(b.second_level_region ?? '')) regions.set(b.second_level_region ?? '', []);
    regions.get(b.second_level_region ?? '')!.push({
      n: b.branch_number, name: b.branch_name,
      branchNumber: b.branch_number, dup: (nameCount.get(b.branch_name) ?? 0) > 1,
    });
  }

  const tree = [...warZones.entries()].map(([wz, regions]) => ({
    name: wz,
    grantable: packs.has(wz),
    users: permCount.get(`范围|${wz}`) ?? 0,
    storeCount: [...regions.values()].reduce((s, xs) => s + xs.length, 0),
    regions: [...regions.entries()].map(([r, stores]) => ({
      name: r,
      grantable: packs.has(r),
      users: permCount.get(`范围|${r}`) ?? 0,
      stores: stores.sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return NextResponse.json({ tree, totalStores: branches.length });
}
