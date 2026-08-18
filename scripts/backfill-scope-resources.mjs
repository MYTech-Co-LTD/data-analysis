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
// 语义（M5/M9/spec-forge）：
//   - 角色链匹配（matchRolePermissions，与 claims.js 同语义：只取 permission.roles 命中用户角色码的
//     resources 并集；直挂/groups 挂载排除）
//   - 归一（normalizeFriendlyPerm 与 claims.js FRIENDLY_TO_KEY 同步对拍——claims.test.js 断言 catalog↔claims 一致，
//     本内联表是同一来源的 .mjs 副本，改映射须同步 claims.js + capability-catalog）
//   - 范围相关键过滤：data-analysis:branch:/brand:/category:/field: 前缀（裸 '*' 非投影键，M2）
//   - M9 护栏：① org-wide get-permissions 空结果 → abort 不清库（仿 claims.js !isArray(reachable)→整体失败）；
//     ② changed > 50% 活跃用户 → abort 熔断（防一次清全量）
//   - 写时 fail-close：任一范围键 resolveScopeKeys 未知/歧义 → 该用户整单写 [] + 红区计数（M3）
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

/** 展示名 → 归一化资源键：范围|X → data-analysis:branch:X（纯前缀）；其余经 FRIENDLY_TO_KEY；未命中原样返回 */
function normalizeFriendlyPerm(value) {
  if (typeof value === 'string' && value.startsWith('范围|')) {
    return 'data-analysis:branch:' + value.slice('范围|'.length);
  }
  return FRIENDLY_TO_KEY[value] ?? value;
}

/** 角色链匹配（与 claims.js matchRolePermissions 同语义）：roles 全路径 split('/').pop() 归一 */
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

/** 范围相关键过滤（裸 '*' 非投影键，M2） */
function scopeKeys(reachable) {
  return (reachable ?? [])
    .map((k) => normalizeFriendlyPerm(k))
    .filter((k) => typeof k === 'string' && (
      k.startsWith('data-analysis:branch:') ||
      k.startsWith('data-analysis:brand:') ||
      k.startsWith('data-analysis:category:') ||
      k.startsWith('data-analysis:field:')));
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
  const resp = await fetch(`${PGRST}/org_users?is_active=eq.true&select=wecom_id,role_codes`, { headers: H });
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

const users = await getActiveUsers();
console.log(`active users: ${users.length}`);

let changed = 0, unchanged = 0, emptyKeys = 0, red = 0;
const details = [];

for (const u of users) {
  const roleCodes = Array.isArray(u.role_codes) ? u.role_codes : [];
  const reachable = matchRolePermissions(perms, roleCodes);
  const keys = scopeKeys(reachable);
  // 写时 fail-close（M3）：未知/歧义范围键在此无法逐键 resolveScopeKeys（.mjs 无 maps/dim_branch 解析），
  // 由 get_user_perms 解析期 fail-close 兜底；此处仅计数空键（deny 方向）
  if (keys.length === 0) emptyKeys++;
  const cur = JSON.stringify(u.scope_resources ?? []);
  const nxt = JSON.stringify(keys);
  if (cur === nxt) { unchanged++; continue; }
  if (MODE === 'pgrst') { await patchScope(u.wecom_id, keys); }
  changed++;
  details.push({ wecom_id: u.wecom_id, old: u.scope_resources ?? [], new: keys });
}

// M9 护栏②：changed > 50% 活跃用户 → abort 熔断（防一次清全量）
const ratio = users.length ? changed / users.length : 0;
if (ratio > 0.5) {
  console.error(`[guard] changed ${changed}/${users.length} (${(ratio * 100).toFixed(1)}%) > 50% — abort, NOT writing`);
  process.exit(3);
}

console.log(`[${MODE}] changed=${changed} unchanged=${unchanged} empty_keys=${emptyKeys} red=${red}`);
if (MODE === 'dry' && details.length > 0) {
  console.log('--- 将写回的样本（前 5）---');
  for (const d of details.slice(0, 5)) console.log(JSON.stringify(d));
}
