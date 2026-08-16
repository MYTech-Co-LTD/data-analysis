// web/lib/sync/group-expand.ts
// 组→门店三态展开（H13）：store 叶子直映 / region=子孙 store 并集 / dept 不参与。
// 未知组 fail-close（ok:false）——调用方（claims 构建）按 C2 处理：不产出门店范围或整体失败。
// ★门店键铁律：输出是 branch_number（全局唯一），RLS 端精确匹配。
import { casdoorFetch } from './casdoor-client';

export interface ExpandResult {
  branch_nums: readonly string[];
  ok: boolean;
  error?: string;
}

// maps_branch_group 经 PostgREST 读（permission-audit.ts 同款 env/头模式）；
// 经 casdoorFetch seam 调用以保持契约测试可 mock（vi.mock('../casdoor-client')），绝对 URL 由 casdoorFetch 直传。
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const PGRST_KEY = process.env.INSFORGE_API_KEY ?? '';
const MAPS_QUERY = `${POSTGREST_URL}/maps_branch_group?is_active=eq.true&select=group_id,group_type,branch_number,is_active`;

export async function expandGroupsToBranches(groups: readonly string[]): Promise<ExpandResult> {
  if (groups.length === 0) return { branch_nums: [], ok: true };   // 空集=authorized ∅，由上层 deny（B1）
  const mapsResp = await casdoorFetch(MAPS_QUERY, {
    headers: { apikey: PGRST_KEY, Authorization: `Bearer ${PGRST_KEY}` },   // 覆盖 Casdoor token——PostgREST 鉴权
  });
  const maps = ((mapsResp as { data?: { group_id: string; group_type: string; branch_number: string | null }[] }).data ?? []);
  const byId = new Map(maps.map((m) => [m.group_id, m]));
  // 严格判定：组名要么精确命中 maps.group_id，要么作为前缀拥有子孙
  const results = new Set<string>();
  for (const g of groups) {
    const exact = byId.get(g);
    if (exact) {
      if (exact.group_type === 'store' && exact.branch_number) results.add(exact.branch_number);
      else if (exact.group_type === 'region') {
        for (const m of maps) if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      }
      // dept：不贡献（H13）
      continue;
    }
    const asRegion = maps.some((m) => m.group_id.startsWith(g + '-'));
    if (asRegion) {
      for (const m of maps) if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      continue;
    }
    return { branch_nums: [], ok: false, error: `unknown group: ${g}` };   // fail-close（H13 未知组）
  }
  return { branch_nums: [...results].sort(), ok: true };
}
