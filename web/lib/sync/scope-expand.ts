// web/lib/sync/scope-expand.ts
// 范围|X 资源键 → 门店集展开（2026-08-18 门店范围唯一真相；与 functions/wecom-oidc-callback/claims.js
// resolveScopeKeys + collapseFullStore 同语义）。供权限预览（preview route）等 web 侧按登录同口径
// 算门店范围——真实登录 branch_nums 由 expandScopeResources 产生，web 侧预览必须一致，否则
// 「预览与实际不一致」（get_user_perms 的 groups 推导 legacy 合成已废弃为展示对照）。
// 键形态：'*' / '全店' 通配 | 包名（maps.group_id，dept 多行）| branch_number（3120-0006）| 门店中文名
//   （dim_branch.branch_name 唯一命中）。
// fail-close：未知键 / 中文名重名或未命中 → ok:false（与登录 C2 同保守方向）。
// 全店覆盖 maps 门店全集 → branch_nums 收敛 ['*']（collapseFullStore 同款，语义=全店授权）。
// ★门店键铁律：输出是 branch_number（全局唯一派生键），RLS 端精确匹配。
import { casdoorFetch } from './casdoor-client';

export interface ScopeExpandResult {
  branch_nums: readonly string[];
  ok: boolean;
  error?: string;
}

// maps_branch_group / dim_branch 经 PostgREST 读（group-expand.ts 同款 env/头模式）；
// 经 casdoorFetch seam 调用以保持契约测试可 mock（vi.mock('../casdoor-client')），绝对 URL 由 casdoorFetch 直传。
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const PGRST_KEY = process.env.INSFORGE_API_KEY ?? '';
const MAPS_QUERY = `${POSTGREST_URL}/maps_branch_group?is_active=eq.true&select=group_id,branch_number`;
const DIM_QUERY = `${POSTGREST_URL}/dim_branch?select=branch_number,branch_name`;

export async function expandScopeResources(scopeKeys: readonly string[]): Promise<ScopeExpandResult> {
  if (scopeKeys.length === 0) return { branch_nums: [], ok: true };   // 空集=authorized ∅，由上层 deny（B1）

  const H = { apikey: PGRST_KEY, Authorization: `Bearer ${PGRST_KEY}` };
  const [mapsResp, dimResp] = await Promise.all([
    casdoorFetch(MAPS_QUERY, { headers: H }),
    casdoorFetch(DIM_QUERY, { headers: H }),
  ]);
  const maps = (mapsResp.data as { group_id: string; branch_number: string | null }[] | undefined) ?? [];
  const dims = (dimResp.data as { branch_number: string; branch_name: string }[] | undefined) ?? [];
  if (mapsResp.ok === false || dimResp.ok === false) {
    return { branch_nums: [], ok: false, error: mapsResp.error ?? dimResp.error ?? 'scope expand fetch failed' };
  }

  const mapsByGroup = new Map<string, string[]>();
  for (const m of maps) {
    if (!m.group_id || !m.branch_number) continue;
    if (!mapsByGroup.has(m.group_id)) mapsByGroup.set(m.group_id, []);
    mapsByGroup.get(m.group_id)!.push(m.branch_number);
  }
  const branchNums = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const byName = new Map<string, string[]>();
  for (const d of dims) {
    if (!d.branch_name || !d.branch_number) continue;
    if (!byName.has(d.branch_name)) byName.set(d.branch_name, []);
    byName.get(d.branch_name)!.push(d.branch_number);
  }

  const results = new Set<string>();
  for (const raw of scopeKeys) {
    const key = String(raw);
    if (key === '*' || key === '全店') return { branch_nums: ['*'], ok: true };   // 通配短路（全店=中文别名）
    const pack = mapsByGroup.get(key);
    if (pack) { for (const b of pack) results.add(b); continue; }                  // 包名 → 包内门店并集
    if (branchNums.has(key)) { results.add(key); continue; }                       // branch_number 直映
    const named = byName.get(key);
    if (named && named.length === 1) { results.add(named[0]); continue; }          // 门店中文名唯一命中
    if (named && named.length > 1) {
      return { branch_nums: [], ok: false, error: `ambiguous store name: ${key} (${named.length} 家重名)` };
    }
    return { branch_nums: [], ok: false, error: `unknown scope key: ${key}` };
  }

  // collapseFullStore：结果覆盖 maps 门店全集 → ['*']（claims.js 同款语义，集合相等才收敛）
  const universe = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const uniq = [...results].sort();
  if (uniq.length === 0 || universe.size === 0) return { branch_nums: uniq, ok: true };
  const covered = uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
  return { branch_nums: covered ? ['*'] : uniq, ok: true };
}
