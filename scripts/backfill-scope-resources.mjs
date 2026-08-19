#!/usr/bin/env node
// scripts/backfill-scope-resources.mjs —— org_users.scope_resources 投影全量回填（方案 A，W2-Task3b）
//
// 背景：scope_resources 只在登录时写穿（wecom-oidc-callback 5b'，W1-Task2），无全量回填通道——
//   Wave1.5 必须在 Wave2（M3 切换 get_user_perms 读投影）前回填全部活跃用户，否则空投影→全员 deny。
//
// 用法（在 deploy-web-1 容器内跑，复用容器 env 的 CASDOOR_*/INSFORGE_API_KEY/POSTGREST_URL）：
//   node backfill-scope-resources.mjs                 # dry-run：只打印计划（默认）
//   node backfill-scope-resources.mjs --write         # 经 PostgREST PATCH 逐行写
//
// 语义（M5/M9/M3/spec-forge，含异种 review 修复）：
//   - 角色链匹配（matchRolePermissions，与 claims.js 同语义：只取 permission.roles 命中用户角色码的
//     resources 并集；直挂/groups 挂载排除）
//   - 归一（normalizeFriendlyPerm 与 claims.js FRIENDLY_TO_KEY 同步对拍——claims.test.js 断言 catalog↔claims 一致，
//     本内联表是同一来源的 .mjs 副本，改映射须同步 claims.js + capability-catalog）
//   - 范围相关键过滤：data-analysis:branch:/brand:/category:/field: 前缀（裸 '*' 非投影键，M2）
//   - M3 fail-close：branch 键经 maps/dim 校验，未知/歧义 → 整单 [] + red；未知键永不进投影（review #4/#5）
//   - M9 护栏（两遍式 review #1）：① org-wide 空结果 → abort 不清库；② changed>50% 在写之前判定 → abort
//   - 幂等：重复跑结果一致

const MODE = process.argv.includes('--write') ? 'pgrst' : 'dry';

const API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';
const ORG = process.env.CASDOOR_ORG || 'shanhai';
const PGRST = process.env.POSTGREST_URL || 'http://postgrest:3000';
const PGRST_KEY = process.env.INSFORGE_API_KEY || '';

// ---- 归一化展示名 → 能力 key（与 claims.js FRIENDLY_TO_KEY 同步；claims.test.js 对拍 catalog）----
const FRIENDLY_TO_KEY = {
  '品牌|熊喵鲜生': 'data-analysis:brand:3120',
  '品牌|品品甜': 'data-analysis:brand:64188',
  '品类|水果': 'data-analysis:category:水果',
  '品类|标品': 'data-analysis:category:标品',
  '品类|耗材': 'data-analysis:category:耗材',
  '字段|成本可见': 'data-analysis:field:cost',
};

function normalizeFriendlyPerm(value) {
  if (typeof value === 'string' && value.startsWith('范围|')) {
    return 'data-analysis:branch:' + value.slice('范围|'.length);
  }
  return FRIENDLY_TO_KEY[value] ?? value;
}

function matchRolePermissions(perms, myRoleCodes) {
  const mine = new Set((myRoleCodes ?? []).map((r) => String(r)));
  const out = new Set();
  for (const p of perms ?? []) {
    const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
    const hit = pr.some((r) => mine.has(r) || mine.has(String(r).split('/').pop()));
    if (!hit) continue;
    for (const res of p.resources ?? []) if (typeof res === 'string') out.add(res);
  }
  return [...out];
}

function scopeKeys(reachable) {
  return (reachable ?? [])
    .map((k) => normalizeFriendlyPerm(k))
    .filter((k) => typeof k === 'string' && (
      k.startsWith('data-analysis:branch:') ||
      k.startsWith('data-analysis:brand:') ||
      k.startsWith('data-analysis:category:') ||
      k.startsWith('data-analysis:field:')));
}

/** M3 fail-close：branch 键解析校验（与 scope-expand.ts 同语义） */
function resolveBranchKeys(branchKeys, maps, dims) {
  if (branchKeys.length === 0) return { branch_nums: [], ok: true };
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
    return { branch_nums: [], ok: false }; // 未知/歧义 → fail-close
  }
  const universe = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const uniq = [...results].sort();
  const covered = uniq.length > 0 && universe.size > 0
    && uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
  return { branch_nums: covered ? ['*'] : uniq, ok: true };
}

async function casdoorToken() {
  const resp = await fetch(`${API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.CASDOOR_CLIENT_ID || '',
      client_secret: process.env.CASDOOR_CLIENT_SECRET || '',
      scope: 'openid',
    }),
  });
  if (!resp.ok) throw new Error(`casdoor token ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

async function getPermissions(token) {
  const resp = await fetch(`${API}/api/get-permissions?owner=${encodeURIComponent(ORG)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`get-permissions ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.data || data.data2 || [];
}

const H = { apikey: PGRST_KEY, Authorization: `Bearer ${PGRST_KEY}`, 'Content-Type': 'application/json' };

async function getActiveUsers() {
  const resp = await fetch(`${PGRST}/org_users?is_active=eq.true&select=wecom_id,role_codes,scope_resources`, { headers: H });
  if (!resp.ok) throw new Error(`org_users ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function patchScope(wecomId, keys) {
  const resp = await fetch(`${PGRST}/org_users?wecom_id=eq.${encodeURIComponent(wecomId)}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ scope_resources: keys }),
  });
  if (!resp.ok) throw new Error(`patch ${wecomId} ${resp.status}: ${await resp.text()}`);
}

const token = await casdoorToken();
const perms = await getPermissions(token);
console.log(`get-permissions: ${perms.length} permissions`);

// M9 护栏①：org-wide 空结果 → abort（仿 claims.js !isArray(reachable)→整体失败，绝不清库）
if (!Array.isArray(perms) || perms.length === 0) {
  console.error('[guard] get-permissions returned empty — abort, NOT wiping projections');
  process.exit(2);
}

const [users, mapsResp, dimResp] = await Promise.all([
  getActiveUsers(),
  fetch(`${PGRST}/maps_branch_group?is_active=eq.true&select=group_id,branch_number`, { headers: H }),
  fetch(`${PGRST}/dim_branch?select=branch_name,branch_number`, { headers: H }),
]);
const maps = (await mapsResp.json()) ?? [];
const dims = (await dimResp.json()) ?? [];
console.log(`active users: ${users.length}`);

// 第一遍：只算 diff（M9 两遍式 #1），含 M3 fail-close 校验
const diffs = [];
let emptyKeys = 0, red = 0;
for (const u of users) {
  const scopeResources = scopeKeys(matchRolePermissions(perms, u.role_codes ?? []));
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
  console.error(`[guard] changed ${diffs.length}/${users.length} (${(ratio * 100).toFixed(1)}%) > 50% — abort before write, NOT wiping projections`);
  process.exit(3);
}

// 第二遍：只写 diff 用户
if (MODE === 'pgrst') {
  let writeFail = 0;
  for (const d of diffs) {
    try { await patchScope(d.wecom_id, d.new); }
    catch (e) { writeFail++; console.error(`patch ${d.wecom_id}: ${e.message}`); }
  }
  console.log(`[write] applied ${diffs.length} diffs, writeFail=${writeFail}`);
} else {
  console.log(`[dry] would change ${diffs.length} users`);
  for (const d of diffs.slice(0, 5)) console.log('  DIFF', JSON.stringify({ wecom_id: d.wecom_id, new: d.new }));
}

console.log(`[${MODE}] changed=${diffs.length} unchanged=${users.length - diffs.length} empty_keys=${emptyKeys} red=${red}`);
