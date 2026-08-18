#!/usr/bin/env node
// scripts/perm-diff-matrix.mjs —— N 用户「JS 解析 vs SQL 解析」差分矩阵（W4-Task8 / S12/spec-forge）
//
// 目的：规模化抓 JS/SQL 解析漂移——对每个活跃用户，同一 scope_resources 输入：
//   SQL 侧 = get_user_perms RPC（migration 200，SQL 解析）
//   JS 侧  = 本脚本内联的 resolveScopeKeys（与 scope-expand.ts/claims.js 同语义）
//   输出「不一致矩阵」；不一致 ≠ 0 即退出非 0（CI/对账可挂）。
//
// 用法（deploy-web-1 容器内，复用 env）：
//   node perm-diff-matrix.mjs                # 全量活跃用户差分
//   node perm-diff-matrix.mjs --limit 20     # 只跑前 20 个
//
// 语义：全店收敛（'*'）/ 分区包 / branch_number / 中文名 / 未知/重名 fail-close——两侧必须逐位一致。

const PGRST = process.env.POSTGREST_URL || 'http://postgrest:3000';
const PGRST_KEY = process.env.INSFORGE_API_KEY || '';
const LIMIT = Number(process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : '9999');

const H = { apikey: PGRST_KEY, Authorization: `Bearer ${PGRST_KEY}`, 'Content-Type': 'application/json' };

/** JS 侧 resolveScopeKeys（与 scope-expand.ts 同语义；scope_resources 存的是 data-analysis:branch:X 归一键） */
function resolveKeys(branchKeys, maps, dims) {
  const mapsByGroup = new Map();
  for (const m of maps) {
    if (!m.group_id || !m.branch_number) continue;
    if (!mapsByGroup.has(m.group_id)) mapsByGroup.set(m.group_id, []);
    mapsByGroup.get(m.group_id).push(m.branch_number);
  }
  const branchNums = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const byName = new Map();
  for (const d of dims) {
    if (!d.branch_name || !d.branch_number) continue;
    if (!byName.has(d.branch_name)) byName.set(d.branch_name, []);
    byName.get(d.branch_name).push(d.branch_number);
  }
  const results = new Set();
  for (const raw of branchKeys) {
    const key = String(raw);
    if (key === '*' || key === '全店') return { branch_nums: ['*'], ok: true };
    const pack = mapsByGroup.get(key);
    if (pack) { for (const b of pack) results.add(b); continue; }
    if (branchNums.has(key)) { results.add(key); continue; }
    const named = byName.get(key);
    if (named && named.length === 1) { results.add(named[0]); continue; }
    if (named && named.length > 1) return { branch_nums: [], ok: false };
    return { branch_nums: [], ok: false };
  }
  const universe = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const uniq = [...results].sort();
  const covered = uniq.length > 0 && universe.size > 0
    && uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
  return { branch_nums: covered ? ['*'] : uniq, ok: true };
}

async function main() {
  // maps + dim 一次性拉（JS 侧解析输入）
  const [mapsResp, dimResp, usersResp] = await Promise.all([
    fetch(`${PGRST}/maps_branch_group?is_active=eq.true&select=group_id,branch_number`, { headers: H }),
    fetch(`${PGRST}/dim_branch?select=branch_number,branch_name`, { headers: H }),
    fetch(`${PGRST}/org_users?is_active=eq.true&select=wecom_id,scope_resources`, { headers: H }),
  ]);
  const maps = (await mapsResp.json()) ?? [];
  const dims = (await dimResp.json()) ?? [];
  const users = (await usersResp.json()) ?? [];

  let diffs = 0, checked = 0;
  const matrix = [];
  for (const u of users.slice(0, LIMIT)) {
    const scopeResources = Array.isArray(u.scope_resources) ? u.scope_resources : [];
    // JS 侧：从归一键提取 branch keys 解析
    const branchKeys = scopeResources
      .filter((k) => typeof k === 'string' && k.startsWith('data-analysis:branch:'))
      .map((k) => k.slice('data-analysis:branch:'.length));
    const js = resolveKeys(branchKeys, maps, dims);
    // SQL 侧：get_user_perms RPC
    const sqlResp = await fetch(`${PGRST}/rpc/get_user_perms`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ p_wecom_id: u.wecom_id }),
    });
    const sql = sqlResp.ok ? await sqlResp.json() : null;
    const sqlBranch = (sql?.data_scope?.branch_nums ?? sql?.branch_nums) ?? [];
    checked++;
    const jsSorted = [...(js.branch_nums ?? [])].sort();
    const sqlSorted = [...sqlBranch].sort();
    const same = JSON.stringify(jsSorted) === JSON.stringify(sqlSorted);
    if (!same) {
      diffs++;
      matrix.push({ wecom_id: u.wecom_id, js: jsSorted, sql: sqlSorted });
    }
  }

  console.log(`checked=${checked} diffs=${diffs}`);
  if (matrix.length > 0) {
    for (const m of matrix.slice(0, 10)) console.log('DIFF', JSON.stringify(m));
  }
  process.exit(diffs > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
