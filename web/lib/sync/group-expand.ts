// web/lib/sync/group-expand.ts
// 组→门店展开（2026-08-17 组树迁移企微部门树后，与 functions/wecom-oidc-callback/claims.js
// resolveGroupBranches 同语义）：
//   新形态（部门组）：maps 行 group_id=部门名 × branch_number 多行——任一命中行即贡献门店
//   （战区/区部门→辖区门店多行；职能部门→全店 388 行），group_type 不再区分。
//   旧形态回退（门店组过渡兼容）：store 前缀子孙并集（'熊喵-3120-xxxx' 形态）。
//   未知组（maps 无精确行亦无前缀子孙）fail-close（ok:false）——调用方按 C2 处理。
//   入参是全路径（'shanhai/山海一果/总经办'，token/F9 投影同源）——尾段截取后按组名查 maps。
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
  const byId = new Map<string, { group_id: string; group_type: string; branch_number: string | null }[]>();
  for (const m of maps) {
    if (!byId.has(m.group_id)) byId.set(m.group_id, []);
    byId.get(m.group_id)!.push(m);
  }
  const results = new Set<string>();
  for (const path of groups) {
    const g = String(path).split('/').pop() ?? String(path);      // 全路径 'shanhai/部门名' → 组名（claims.js 同款）
    // 新形态：部门组多行映射——精确命中的行全部贡献（group_type 不区分）
    const exact = (byId.get(g) ?? []).filter((m) => m.branch_number);
    if (exact.length > 0) {
      for (const m of exact) results.add(m.branch_number!);
      continue;
    }
    // 旧形态回退（门店组过渡）：前缀 store 子孙并集
    const asRegion = maps.some((m) => m.group_type === 'store' && m.group_id.startsWith(g + '-'));
    if (asRegion) {
      for (const m of maps) if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      continue;
    }
    return { branch_nums: [], ok: false, error: `unknown group: ${g}` };   // fail-close（H13 未知组）
  }
  return { branch_nums: [...results].sort(), ok: true };
}
