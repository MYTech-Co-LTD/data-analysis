// web/app/api/admin/scope-overview/route.ts
// 2026-08-18 门店范围显式授权 P3：管理后台「数据范围总览」数据源。
// 两块同屏：Casdoor 显式范围/品牌/品类/字段资源（中文）· 企微部门组（旧通道对照，仅目录）。
// （例外体系已废除 2026-08-18：temporary_grants 不再展示为授权通道。）
// 附体检项：悬空范围资源 / 零范围用户 / 单店资源 / 门店重名。
// 门禁：requireAdmin。Casdoor 或 PostgREST 任一不可达 → 降级 503 带原因（页面显示不可用）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { casdoorFetch } from '@/lib/sync/casdoor-client';

export const dynamic = 'force-dynamic';

const ORG = process.env.CASDOOR_ORG || 'shanhai';
const PGRST = process.env.POSTGREST_URL || 'http://postgrest:3000';

export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;

  // ① Casdoor：用户 + permissions
  const [usersRes, permsRes] = await Promise.all([
    casdoorFetch(`/api/get-users?owner=${encodeURIComponent(ORG)}&limit=1000`),
    casdoorFetch(`/api/get-permissions?owner=${encodeURIComponent(ORG)}`),
  ]);
  if (!usersRes.ok || !permsRes.ok) {
    return NextResponse.json({ error: 'casdoor_unavailable', detail: usersRes.error ?? permsRes.error }, { status: 503 });
  }
  const users = (Array.isArray(usersRes.data) ? usersRes.data : (usersRes.data as { data?: unknown[] })?.data ?? []) as Array<{
    name: string; displayName?: string; groups?: string[]; isForbidden?: boolean;
  }>;
  const perms = (Array.isArray(permsRes.data) ? permsRes.data : (permsRes.data as { data?: unknown[] })?.data ?? []) as Array<{
    name: string; displayName?: string; users?: string[]; resources?: string[];
  }>;

  // ② 本地：maps（包定义）+ dim_branch（门店名）
  const pgrstGet = async (path: string) => {
    const r = await fetch(`${PGRST}${path}`, { headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  };
  let maps: Array<{ group_id: string; branch_number: string }>;
  let dimBranches: Array<{ branch_number: string; branch_name: string }>;
  try {
    [maps, dimBranches] = await Promise.all([
      pgrstGet('/maps_branch_group?is_active=eq.true&select=group_id,branch_number'),
      pgrstGet('/dim_branch?select=branch_number,branch_name'),
    ]);
  } catch (e) {
    return NextResponse.json({ error: 'postgrest_unavailable', detail: (e as Error).message }, { status: 503 });
  }

  const packIds = new Set(maps.map((m) => m.group_id));
  const branchNums = new Set(maps.map((m) => m.branch_number));
  const nameCount = new Map<string, number>();
  for (const d of dimBranches) nameCount.set(d.branch_name, (nameCount.get(d.branch_name) ?? 0) + 1);

  // ③ 组装：per-user 授权面
  const rows = users
    .filter((u) => u.name && u.name !== 'admin')
    .map((u) => {
      const userPerms = perms.filter((p) => (p.users ?? []).includes(`${ORG}/${u.name}`));
      const resources = [...new Set(userPerms.flatMap((p) => p.resources ?? []))];
      const scopeRes = resources.filter((r) => r.startsWith('范围|'));
      const brandRes = resources.filter((r) => r.startsWith('品牌|'));
      const categoryRes = resources.filter((r) => r.startsWith('品类|'));
      const fieldRes = resources.filter((r) => r.startsWith('字段|'));
      return {
        user: u.name,
        display: u.displayName ?? '',
        disabled: u.isForbidden === true,
        legacyGroups: (u.groups ?? []).map((g) => String(g).split('/').pop()),
        scope: scopeRes, brands: brandRes, categories: categoryRes, fields: fieldRes,
        scopePermissions: userPerms.filter((p) => (p.resources ?? []).some((r) => r.startsWith('范围|'))).map((p) => p.name),
      };
    });

  // ④ 体检项
  const checks: Array<{ kind: string; user?: string; detail: string; level: 'warn' | 'info' }> = [];
  for (const r of rows) {
    for (const s of r.scope) {
      const key = s.slice('范围|'.length);
      if (key === '*' || key === '全店') continue;
      if (packIds.has(key) || branchNums.has(key)) continue;
      const isStoreName = dimBranches.some((d) => d.branch_name === key);
      if (!isStoreName) checks.push({ kind: 'M-dangling-scope', user: r.user, detail: `范围资源「${s}」在 maps/dim_branch 均不存在（企微删组后悬空？）`, level: 'warn' });
      else if ((nameCount.get(key) ?? 0) > 1) checks.push({ kind: 'M-ambiguous-store', user: r.user, detail: `门店名「${key}」重名 ${nameCount.get(key)} 家，登录解析 fail-close`, level: 'warn' });
    }
    if (r.scope.length === 0) {
      checks.push({ kind: 'M-empty-scope', user: r.user, detail: '无范围资源——登录后门店维 deny（B1，2026-08-18 起不再从部门组/例外推导）', level: 'info' });
    }
    const singleStores = r.scope.filter((s) => branchNums.has(s.slice('范围|'.length)) || (nameCount.get(s.slice('范围|'.length)) ?? 0) === 1);
    if (singleStores.length > 0) {
      checks.push({ kind: 'M-single-store-grant', user: r.user, detail: `直挂单店：${singleStores.join(' · ')}（精确授权，注意审计）`, level: 'info' });
    }
  }

  return NextResponse.json({
    rows,
    checks,
    meta: {
      users: rows.length,
      scopePermissions: perms.filter((p) => (p.resources ?? []).some((r) => r.startsWith('范围|'))).length,
      duplicateStoreNames: [...nameCount.entries()].filter(([, n]) => n > 1).map(([name, n]) => ({ name, count: n })),
    },
  });
}
