// web/lib/jobs/reconcile-scope-resources/manifest.ts
// 薄同步 + 对账 job（方案 A M5/spec-forge）：每日把 Casdoor 角色链范围资源投影到 org_users.scope_resources。
//   薄同步 = 逐人 matchRolePermissions(get-permissions, role_codes) → normalizeFriendlyPerm → 范围键过滤 → upsert；
//   对账   = 在原始资源键层面对比（Casdoor→归一→过滤 → vs 投影），写 history + red 告警。
//   M9 护栏（异种 review #1 修复：两遍式——先算 diff 后写，防一次清全量）：
//     ① org-wide 空结果 abort 不清库（仿 claims.js !isArray(reachable)→整体失败）
//     ② changed>50% 在写之前判定，超限直接 abort（投影未被污染）
//   M3 fail-close（异种 review #4 修复）：逐人 branch 键经 maps/dim 校验，未知/歧义 → 整单 [] + red，
//     未知键永不进投影（消解 JS/SQL 键序分歧 #5）。
//   M16 教训：job 必须进 JOBS registry（registry.ts）才会被注册。
import { casdoorFetch } from '../../sync/casdoor-client';
import { matchRolePermissions, normalizeFriendlyPerm } from '../../sync/role-scope';
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { POSTGREST_URL, INSFORGE_API_KEY } from '../env';

const ORG = process.env.CASDOOR_ORG || 'shanhai';
const CASDOOR_API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';

const PG_H = (): Record<string, string> => {
  const KEY = process.env.INSFORGE_API_KEY!;
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
};

/** 范围相关键过滤（裸 '*' 非投影键，M2） */
export function scopeKeys(reachable: readonly string[]): string[] {
  return (reachable ?? [])
    .map((k) => normalizeFriendlyPerm(k))
    .filter((k) => typeof k === 'string' && (
      k.startsWith('data-analysis:branch:') ||
      k.startsWith('data-analysis:brand:') ||
      k.startsWith('data-analysis:category:') ||
      k.startsWith('data-analysis:field:')));
}

/**
 * M3 fail-close：branch 键解析校验（与 scope-expand.ts/claims.js resolveScopeKeys 同语义）。
 * 任一未知/歧义键 → { branch_nums: [], ok: false }——整单 fail-close 写 [] + red（B1 deny），未知键永不进投影。
 * 通配 '全店'/'*' → ['*']；maps 包名/branch_number/中文名唯一 → 门店集；结果覆盖 maps 全集 → 收敛 ['*']。
 */
export function resolveBranchKeys(
  branchKeys: readonly string[],
  maps: Array<{ group_id: string; branch_number: string | null }>,
  dims: Array<{ branch_name: string; branch_number: string }>,
): { branch_nums: string[]; ok: boolean } {
  if (branchKeys.length === 0) return { branch_nums: [], ok: true };
  const mapsByGroup = new Map<string, string[]>();
  for (const m of maps) {
    if (!m.group_id || !m.branch_number) continue;
    if (!mapsByGroup.has(m.group_id)) mapsByGroup.set(m.group_id, []);
    mapsByGroup.get(m.group_id)!.push(m.branch_number);
  }
  const branchNums = new Set(maps.map((m) => m.branch_number).filter((b): b is string => !!b));
  const byName = new Map<string, string[]>();
  for (const d of dims) {
    if (!d.branch_name || !d.branch_number) continue;
    if (!byName.has(d.branch_name)) byName.set(d.branch_name, []);
    byName.get(d.branch_name)!.push(d.branch_number);
  }
  const results = new Set<string>();
  for (const raw of branchKeys) {
    const key = String(raw);
    if (key === '*' || key === '全店') return { branch_nums: ['*'], ok: true };
    const pack = mapsByGroup.get(key);
    if (pack) { for (const b of pack) results.add(b); continue; }
    if (branchNums.has(key)) { results.add(key); continue; }
    const named = byName.get(key);
    if (named && named.length === 1) { results.add(named[0]); continue; }
    return { branch_nums: [], ok: false }; // 未知/歧义 → fail-close
  }
  const universe = new Set(maps.map((m) => m.branch_number).filter((b): b is string => !!b));
  const uniq = [...results].sort();
  const covered = uniq.length > 0 && universe.size > 0
    && uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
  return { branch_nums: covered ? ['*'] : uniq, ok: true };
}

async function pgrstGet<T>(path: string): Promise<T[]> {
  const res = await fetch(`${POSTGREST_URL}${path}`, { headers: PG_H() });
  if (!res.ok) throw new Error(`pgrst ${path} ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function upsertHistory(row: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${POSTGREST_URL}/scope_resources_reconcile_history`, {
    method: 'POST',
    headers: { ...PG_H(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!res.ok) console.error(`upsertHistory ${res.status}: ${await res.text().catch(() => '')}`);
}

export const reconcileScopeResourcesManifest: JobManifest = {
  id: 'reconcile-scope-resources',
  schedule: '37 3 * * *', // 03:37，与 reconcile-groups 同批（错开采集 8-23 / 对账 02:00 / 门店树 03:17）
  dependsOn: ['reconcile-groups'],
  async run(): Promise<JobResult> {
    // ① org-wide get-permissions（角色链匹配输入）
    const permsResp = await casdoorFetch(`${CASDOOR_API}/api/get-permissions?owner=${encodeURIComponent(ORG)}`, {});
    if (permsResp.ok === false) throw new Error(`get-permissions failed: ${permsResp.error}`);
    const perms = (permsResp.data as Array<{ roles?: string[]; resources?: string[] }>) ?? [];

    // M9 护栏①：org-wide 空结果 → abort 不清库
    if (!Array.isArray(perms) || perms.length === 0) {
      const msg = '[reconcile-scope-resources] get-permissions returned empty — abort, NOT wiping projections';
      console.error(msg);
      await notifyWecom('scope_resources 对账中止', msg);
      return { status: 'error', message: msg };
    }

    // ② 活跃用户 + maps/dim（M3 校验输入）
    const [users, maps, dims] = await Promise.all([
      pgrstGet<{ wecom_id: string; role_codes: string[] | null; scope_resources: string[] | null }>(
        '/org_users?is_active=eq.true&select=wecom_id,role_codes,scope_resources'),
      pgrstGet<{ group_id: string; branch_number: string | null }>(
        '/maps_branch_group?is_active=eq.true&select=group_id,branch_number'),
      pgrstGet<{ branch_name: string; branch_number: string }>(
        '/dim_branch?select=branch_name,branch_number'),
    ]);

    // ③ 第一遍：只算 diff，不写（M9 两遍式 #1）
    const diffs: Array<{ wecom_id: string; old: string[]; new: string[] }> = [];
    let emptyKeys = 0, red = 0;
    for (const u of users) {
      const scopeResources = scopeKeys(matchRolePermissions(perms, u.role_codes ?? []));
      // M3 fail-close：branch 键校验——未知/歧义 → 整单 [] + red
      const branchKeys = scopeResources
        .filter((k) => k.startsWith('data-analysis:branch:'))
        .map((k) => k.slice('data-analysis:branch:'.length));
      let keys = scopeResources;
      if (branchKeys.length > 0) {
        const resolved = resolveBranchKeys(branchKeys, maps, dims);
        if (!resolved.ok) { keys = []; red++; }
      }
      if (keys.length === 0) emptyKeys++;
      const cur = JSON.stringify(u.scope_resources ?? []);
      const nxt = JSON.stringify(keys);
      if (cur !== nxt) diffs.push({ wecom_id: u.wecom_id, old: u.scope_resources ?? [], new: keys });
    }

    // M9 护栏②：changed > 50% → 写之前 abort（投影未被污染）
    const ratio = users.length ? diffs.length / users.length : 0;
    if (ratio > 0.5) {
      const msg = `[reconcile-scope-resources] changed ${diffs.length}/${users.length} (${(ratio * 100).toFixed(1)}%) > 50% — abort before write`;
      console.error(msg);
      await notifyWecom('scope_resources 对账熔断', msg);
      return { status: 'error', message: msg };
    }

    // ④ 第二遍：只写 diff 用户（薄同步本体；失败计数进 red）
    let writeFail = 0;
    for (const d of diffs) {
      const patch = await fetch(
        `${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(d.wecom_id)}`,
        { method: 'PATCH', headers: PG_H(), body: JSON.stringify({ scope_resources: d.new }) },
      );
      if (!patch.ok) { writeFail++; console.error(`patch ${d.wecom_id} ${patch.status}`); }
    }

    // ⑤ 写 history（date PK UPSERT，幂等；#9 北京时区自然日）
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    await upsertHistory({ date, changed: diffs.length, unchanged: users.length - diffs.length, empty_keys: emptyKeys, red_count: red + writeFail, detail: { sample: diffs.slice(0, 5) } });

    // ⑥ red > 0 → 告警（不静默）
    if (red + writeFail > 0) {
      await notifyWecom('scope_resources 对账红区', `red=${red} writeFail=${writeFail}，date=${date}`);
    }

    console.log(`[reconcile-scope-resources] changed=${diffs.length} unchanged=${users.length - diffs.length} empty_keys=${emptyKeys} red=${red + writeFail}`);
    return { status: 'ok', message: `changed=${diffs.length} unchanged=${users.length - diffs.length} empty=${emptyKeys} red=${red + writeFail}`, detail: { changed: diffs.length, unchanged: users.length - diffs.length, empty_keys: emptyKeys, red_count: red + writeFail } };
  },
};
