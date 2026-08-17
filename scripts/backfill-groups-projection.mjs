#!/usr/bin/env node
// scripts/backfill-groups-projection.mjs —— org_users.groups 投影全量回填（F9，2026-08-17 组树迁移后）
//
// 背景：org_users.groups 只在登录时写穿（wecom-oidc-callback 5b），无全量回填通道——
//   组树迁移（PR#18）后大部分用户从未登录，投影为空/陈旧（旧门店树组名），导致：
//   ① get_user_perms/agent-query/run_push 无会话路径展开空集（B1 deny 方向，agent-query 旧代码反而全放）
//   ② reconcile-groups 实际集失真
// 本脚本从 Casdoor（真相源）拉全部用户挂组，构造 token 同款全路径（父链拼接，如
//   'shanhai/山海一果/总经办'——与 useGroupPathInToken 输出一致），幂等写回 org_users.groups。
//
// 用法（在 deploy-web-1 容器内跑，复用容器 env 的 CASDOOR_*/POSTGREST 或直接产 SQL 走 psql）：
//   node backfill-groups-projection.mjs                 # dry-run：只打印计划（默认）
//   node backfill-groups-projection.mjs --write-sql     # 打印 SQL（由调用方管道给 psql 执行）
//   node backfill-groups-projection.mjs --write         # 经 PostgREST PATCH 逐行写（需 INSFORGE_API_KEY）
//
// 语义：
//   - 只写 Casdoor 侧有组的用户；Casdoor 无组的用户 groups 置 '[]'（Authorized ∅，deny 方向）
//   - 不动 is_active=false / Casdoor 缺席的本地用户（离职面由离职收权管，不在本脚本）
//   - 幂等：重复跑结果一致

const MODE = process.argv.includes('--write') ? 'pgrst'
  : process.argv.includes('--write-sql') ? 'sql' : 'dry';

const API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';
const ORG = process.env.CASDOOR_ORG || 'shanhai';

// ---- Casdoor client_credentials ----
const tokResp = await fetch(`${API}/api/login/oauth/access_token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: process.env.CASDOOR_CLIENT_ID,
    client_secret: process.env.CASDOOR_CLIENT_SECRET,
  }),
});
const token = (await tokResp.json()).access_token;
if (!token) { console.error('Casdoor token 获取失败'); process.exit(2); }
const H = { Authorization: `Bearer ${token}` };
const pages = (b) => [...(Array.isArray(b.data) ? b.data : []), ...(Array.isArray(b.data2) ? b.data2 : []), ...(Array.isArray(b.data3) ? b.data3 : [])];

// ---- 组全路径构造（父链 → 'shanhai/山海一果/总经办'，与 useGroupPathInToken 同源语义）----
const groups = (await pages(await (await fetch(`${API}/api/get-groups?owner=${ORG}`, { headers: H })).json())).filter(g => g.owner === ORG);
const byName = new Map(groups.map(g => [g.name, g]));
const fullPathCache = new Map();
function fullPath(name) {
  if (fullPathCache.has(name)) return fullPathCache.get(name);
  const segs = [];
  let cur = byName.get(name);
  while (cur && cur.name && cur.name !== ORG) { segs.unshift(cur.name); cur = byName.get(cur.parentId); }
  const p = segs.length ? `${ORG}/${segs.join('/')}` : null;
  fullPathCache.set(name, p);
  return p;
}

// ---- 用户挂组（列表接口 user.groups 为 'shanhai/组名' 一级路径 → 取尾段组名 → 全路径）----
let users = [];
for (let p = 1; p <= 5; p++) {
  const batch = await pages(await (await fetch(`${API}/api/get-users?owner=${ORG}&p=${p}&pageSize=100`, { headers: H })).json());
  if (!batch.length) break;
  users = users.concat(batch);
  if (batch.length < 100) break;
}
const plan = [];
for (const u of users) {
  if (u.isUserDeleted === true || u.deleted === true) continue;
  const groupRefs = (u.groups || []).map(g => (typeof g === 'string' ? g : g.name)).map(s => String(s).split('/').pop());
  const paths = [...new Set(groupRefs.map(fullPath).filter(Boolean))].sort();
  plan.push({ wecom_id: u.name, groups: paths });
}
plan.sort((a, b) => a.wecom_id.localeCompare(b.wecom_id));

// ---- 输出 ----
if (MODE === 'dry') {
  console.log(`[dry-run] Casdoor 活跃用户 ${plan.length} 人；写回 org_users.groups 计划：`);
  for (const p of plan) console.log(`  ${p.wecom_id.padEnd(22)} -> ${JSON.stringify(p.groups)}`);
  console.log(`[dry-run] 共 ${plan.length} 行（--write-sql 产 SQL / --write 经 PostgREST 写）`);
  process.exit(0);
}
if (MODE === 'sql') {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  console.log('-- backfill org_users.groups from Casdoor（幂等；BEGIN/COMMIT 由调用方包裹）');
  for (const p of plan) console.log(`UPDATE org_users SET groups = ${q(JSON.stringify(p.groups))}::jsonb WHERE wecom_id = ${q(p.wecom_id)};`);
  process.exit(0);
}
// pgrst 模式
const BASE = process.env.INSFORGE_API_BASE || 'http://localhost:7130';
const KEY = process.env.INSFORGE_API_KEY;
if (!KEY) { console.error('--write 需要 INSFORGE_API_KEY'); process.exit(2); }
let ok = 0, fail = 0;
for (const p of plan) {
  const r = await fetch(`${BASE}/api/pg/rest/v1/org_users?wecom_id=eq.${encodeURIComponent(p.wecom_id)}`, {
    method: 'PATCH', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ groups: p.groups }),
  });
  r.ok ? ok++ : (fail++, console.error(`FAIL ${p.wecom_id}: ${r.status}`));
}
console.log(`written ok=${ok} fail=${fail}`);
process.exit(fail ? 1 : 0);
