// web/lib/sync/scope-packs.ts
// 范围包同步（2026-08-19 用户裁定：能力页 = 真相源）：
//   dim_branch 区域体系（first_level_region ∪ second_level_region 非空值）→ maps_branch_group 区域包投影。
//   不变量：能力页树上的区域节点，maps 必有同名包——树上可复制的键，登录 resolveScopeKeys 必可解析。
//   旧职能全店包（企微部门名 × 388 行）已废弃删除（迁移 199）；本模块是日常保持投影一致的同步方，
//   与迁移 199 语义相同：以 dim 区域为准收敛 maps（补缺包/补缺行/删多余 sync 行），不触碰 manual 行。
// 时机：随每日 drift job 跑（04:23）；dim_branch 由 collect job 更新后自然跟进。
// 幂等：差集操作，重复执行收敛到同一状态。
import { POSTGREST_URL, INSFORGE_API_KEY } from '../jobs/env';

export interface ScopePacksResult {
  ok: boolean;
  addedPacks: string[];      // 新建的区域包
  addedRows: number;         // 补插的 (包,门店) 行
  removedRows: number;       // 删除的多余 sync 行（区域消失/门店易区）
  skippedManual: string[];   // 保留未动的 manual 包（人工维护，同步不碰）
  error?: string;
}

interface MapRow { group_id: string; branch_number: string; source: string }
interface DimRow {
  branch_number: string | null;
  first_level_region: string | null;
  second_level_region: string | null;
  is_active: boolean;
}

const PG_H = (): Record<string, string> => ({
  apikey: INSFORGE_API_KEY!,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
});

export async function syncScopePacks(): Promise<ScopePacksResult> {
  const out: ScopePacksResult = { ok: false, addedPacks: [], addedRows: 0, removedRows: 0, skippedManual: [] };
  try {
    const [mapsResp, dimResp] = await Promise.all([
      fetch(`${POSTGREST_URL}/maps_branch_group?select=group_id,branch_number,source`, { headers: PG_H(), cache: 'no-store' }),
      fetch(`${POSTGREST_URL}/dim_branch?select=branch_number,first_level_region,second_level_region,is_active`, { headers: PG_H(), cache: 'no-store' }),
    ]);
    if (!mapsResp.ok || !dimResp.ok) {
      out.error = `fetch failed maps=${mapsResp.status} dim=${dimResp.status}`;
      return out;
    }
    const maps = (await mapsResp.json()) as MapRow[];
    const dims = (await dimResp.json()) as DimRow[];

    // 期望投影：dim 活跃门店 × 区域值 → (group_id, branch_number) 集合
    const expected = new Set<string>();
    const packs = new Set<string>();
    for (const d of dims) {
      if (!d.is_active || !d.branch_number) continue;
      for (const region of [d.first_level_region, d.second_level_region]) {
        if (region && region !== '') {
          expected.add(`${region}\u0000${d.branch_number}`);
          packs.add(region);
        }
      }
    }

    // 现状差集（只管 source='sync' 行；manual 行跳过并上报）
    const existingSync = new Set<string>();
    for (const m of maps) {
      if (m.source === 'manual') { out.skippedManual.push(m.group_id); continue; }
      existingSync.add(`${m.group_id}\u0000${m.branch_number}`);
    }
    const existingPackNames = new Set(maps.map((m) => m.group_id));

    const toAdd = [...expected].filter((k) => !existingSync.has(k));
    const toRemove = [...existingSync].filter((k) => !expected.has(k));

    // 补缺行（PostgREST 无 \u0000 直插，用对象数组）
    if (toAdd.length > 0) {
      const rows = toAdd.map((k) => {
        const [group_id, branch_number] = k.split('\u0000');
        return { group_id, group_name: group_id, group_type: 'region', branch_number, is_active: true, source: 'sync' };
      });
      const ins = await fetch(`${POSTGREST_URL}/maps_branch_group`, {
        method: 'POST', headers: PG_H(),
        body: JSON.stringify(rows),
      });
      if (!ins.ok) { out.error = `insert failed ${ins.status}`; return out; }
      out.addedRows = rows.length;
      out.addedPacks = [...new Set(rows.map((r) => r.group_id).filter((g) => !existingPackNames.has(g)))];
    }

    // 删多余 sync 行（逐条 or 条件删除——按 (group_id,branch_number) 复合条件批删）
    for (const k of toRemove) {
      const [group_id, branch_number] = k.split('\u0000');
      const del = await fetch(
        `${POSTGREST_URL}/maps_branch_group?group_id=eq.${encodeURIComponent(group_id)}&branch_number=eq.${encodeURIComponent(branch_number)}&source=eq.sync`,
        { method: 'DELETE', headers: PG_H() },
      );
      if (del.ok) out.removedRows++;
    }

    out.ok = true;
    return out;
  } catch (e) {
    out.error = `scope pack sync failed: ${(e as Error).message}`;
    return out;
  }
}
