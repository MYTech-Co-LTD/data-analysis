// web/lib/jobs/reconcile-scope-resources/manifest.ts
// 薄同步 + 对账 job（方案 A M5/spec-forge）：每日把 Casdoor 角色链范围资源投影到 org_users.scope_resources。
//   薄同步 = 逐人 matchRolePermissions(get-permissions, role_codes) → normalizeFriendlyPerm → 范围键过滤 → upsert；
//   对账   = 在原始资源键层面对比（Casdoor→归一→过滤 → vs 投影），写 history + red 告警。
//   M9 护栏：org-wide 空结果 abort 不清库（仿 claims.js !isArray(reachable)→整体失败）；changed>50% 熔断。
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

interface HistoryRow {
  date: string; changed: number; unchanged: number; empty_keys: number; red_count: number; detail?: unknown;
}

async function pgrstGet<T>(path: string): Promise<T[]> {
  const res = await fetch(`${POSTGREST_URL}${path}`, { headers: PG_H() });
  if (!res.ok) throw new Error(`pgrst ${path} ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function upsertHistory(row: HistoryRow): Promise<void> {
  await fetch(`${POSTGREST_URL}/scope_resources_reconcile_history`, {
    method: 'POST',
    headers: { ...PG_H(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
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

    // ② 活跃用户
    const users = await pgrstGet<{ wecom_id: string; role_codes: string[] | null; scope_resources: string[] | null }>(
      '/org_users?is_active=eq.true&select=wecom_id,role_codes,scope_resources',
    );

    // ③ 逐人计算 + 对账
    let changed = 0, unchanged = 0, emptyKeys = 0, red = 0;
    const diffs: Array<{ wecom_id: string; old: string[]; new: string[] }> = [];
    for (const u of users) {
      const keys = scopeKeys(matchRolePermissions(perms, u.role_codes ?? []));
      if (keys.length === 0) emptyKeys++;
      const cur = JSON.stringify(u.scope_resources ?? []);
      const nxt = JSON.stringify(keys);
      if (cur === nxt) { unchanged++; continue; }
      changed++;
      diffs.push({ wecom_id: u.wecom_id, old: u.scope_resources ?? [], new: keys });
      // 逐行写（薄同步本体；失败计数进 red）
      const patch = await fetch(
        `${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(u.wecom_id)}`,
        { method: 'PATCH', headers: PG_H(), body: JSON.stringify({ scope_resources: keys }) },
      );
      if (!patch.ok) { red++; console.error(`patch ${u.wecom_id} ${patch.status}`); }
    }

    // M9 护栏②：changed > 50% → abort 熔断（防一次清全量）
    const ratio = users.length ? changed / users.length : 0;
    if (ratio > 0.5) {
      const msg = `[reconcile-scope-resources] changed ${changed}/${users.length} (${(ratio * 100).toFixed(1)}%) > 50% — abort`;
      console.error(msg);
      await notifyWecom('scope_resources 对账熔断', msg);
      return { status: 'error', message: msg };
    }

    // ④ 写 history（date PK UPSERT，幂等）
    const date = new Date().toISOString().slice(0, 10);
    await upsertHistory({ date, changed, unchanged, empty_keys: emptyKeys, red_count: red, detail: { sample: diffs.slice(0, 5) } });

    // ⑤ red > 0 → 告警（不静默）
    if (red > 0) {
      await notifyWecom('scope_resources 对账红区', `red=${red}（patch 失败/写时 fail-close），date=${date}`);
    }

    console.log(`[reconcile-scope-resources] changed=${changed} unchanged=${unchanged} empty_keys=${emptyKeys} red=${red}`);
    return { status: 'ok', message: `changed=${changed} unchanged=${unchanged} empty=${emptyKeys} red=${red}`, detail: { changed, unchanged, empty_keys: emptyKeys, red_count: red } };
  },
};
