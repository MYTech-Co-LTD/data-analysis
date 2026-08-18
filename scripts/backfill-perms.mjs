#!/usr/bin/env node
// scripts/backfill-perms.mjs —— W4 存量回填（B4/M1，Task 15）
// plan（推导）→ apply（调 Casdoor，经 casdoor-client 同款 client_credentials）
// → diff 门禁（逐用户 claims 派生 scope vs 冻结快照 = 0 才放行消费侧切）。
// 门店集合 = branch_number 全局唯一（门店键铁律）；通配 ["*"] 不逐店挂组（manual-review 人工核对）。
//
// 用法（门禁演练位骨架；Casdoor 真调用 W4 演练时接通，本 task 只留模式）：
//   node scripts/backfill-perms.mjs --plan-only [--write]   读 perm_freeze_snapshot → 打印回填 plan（--write 落 perm_backfill_plan 工作台，幂等）
//   node scripts/backfill-perms.mjs --apply [--live]        按工作台 pending 行调 Casdoor（默认 mock 只打印；--live 需 CASDOOR_* env）
//   node scripts/backfill-perms.mjs --diff-only --claims <file>  逐用户四维 diff；退出码 0 = diff 全零（B4 门禁）
//
// 实现勘误（T15，对齐 plan 逐字测试基线，2026-08-16）：
//   1) plan 行补 user_id 字段（= subject_id）——基线测试按 p.user_id 过滤；
//   2) setEq 参数序为 (快照, claims)——基线测试 d2 期望「快照有/claims 无」记 extra（待补授权），
//      missing 反之为「claims 有/基线无」（多授予）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---- 纯函数（plan 基线 + 上述两处勘误） ----

export function planBackfill(snapshot, { groupOf }) {
  const plan = [];
  for (const row of snapshot) {
    for (const b of row.brands ?? []) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id, user_id: row.subject_id,
      action: 'grant-resource', payload: { key: `data-analysis:brand:${b}` } });
    for (const c of row.categories ?? []) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id, user_id: row.subject_id,
      action: 'grant-resource', payload: { key: `data-analysis:category:${c}` } });
    if (row.can_see_cost) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id, user_id: row.subject_id,
      action: 'grant-resource', payload: { key: 'data-analysis:field:cost' } });
    const bns = row.branch_nums ?? [];
    if (bns.includes('*')) {
      plan.push({ subject_type: row.subject_type, subject_id: row.subject_id, user_id: row.subject_id,
        action: 'manual-review', payload: { reason: 'wildcard-branch', note: '通配门店改挂区域组或逐组勾选，人工定' } });
    } else {
      for (const bn of bns) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id, user_id: row.subject_id,
        action: 'attach-group', payload: { group: groupOf(bn), branch_number: bn } });
    }
  }
  return plan;
}

const setEq = (a, b) => { const A = new Set(a), B = new Set(b);
  return { missing: [...B].filter((x) => !A.has(x)), extra: [...A].filter((x) => !B.has(x)) }; };

// 逐用户四维 diff（集合语义，顺序无关）。extra = 快照基线要求、claims 未兑现（待补授权）；
// missing = claims 有、基线无（多授予）。全等返回空数组（B4 门禁放行条件）。
export function diffScope(claimsScope, snapScope) {
  const out = [];
  for (const dim of ['brands', 'categories', 'branch_nums']) {
    const { missing, extra } = setEq(snapScope[dim] ?? [], claimsScope[dim] ?? []);
    if (missing.length || extra.length) out.push({ dim, missing, extra });
  }
  if ((claimsScope.can_see_cost ?? false) !== (snapScope.can_see_cost ?? false))
    out.push({ dim: 'can_see_cost', missing: [], extra: [String(claimsScope.can_see_cost)] });
  return out;
}

// ---- CLI 骨架（模式同 shadow-diff.mjs / u2_switch.mjs；Casdoor 同款 client_credentials，本 task 不真调） ----

const CONTAINER = process.env.PG_CONTAINER || 'deploy-postgres-1';
const CASDOOR_API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

function psqlJson(sql) {
  const out = execFileSync(
    'docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'insforge', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' },
  );
  return JSON.parse(out.trim() || 'null');
}

// 快照读取（对账基线必须带哨兵读快照——防错基线，Task 14 约定）
function readSnapshot() {
  const sentinel = psqlJson(`SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT key, frozen_at FROM perm_freeze_sentinel) t`);
  if (!sentinel.length) {
    throw new Error('perm_freeze_sentinel 为空：快照未冻结（先 SELECT freeze_perms()），拒绝以非冻结基线跑回填/门禁');
  }
  return psqlJson(`SELECT coalesce(json_agg(t), '[]'::json)
    FROM (SELECT subject_type, subject_id, brands, categories, branch_nums, can_see_cost FROM perm_freeze_snapshot) t`);
}

// groupOf 数据源：maps_branch_group（迁移178，active store 行）branch_number → group_name
function readGroupMap() {
  const rows = psqlJson(`SELECT coalesce(json_agg(t), '[]'::json)
    FROM (SELECT branch_number, group_name FROM maps_branch_group WHERE is_active AND group_type = 'store') t`);
  return new Map(rows.map((r) => [r.branch_number, r.group_name]));
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // SQL 单引号转义（payload 走 ::jsonb 字面量）

function writePlan(plan) {
  if (!plan.length) return 0;
  const values = plan.map((p) =>
    `(${q(p.subject_type)}, ${q(p.subject_id)}, ${q(p.action)}, ${q(JSON.stringify(p.payload))})`).join(',\n  ');
  const sql = `INSERT INTO perm_backfill_plan(subject_type, subject_id, action, payload)
SELECT v.st, v.sid, v.act, v.payload::jsonb
FROM (VALUES ${values}) AS v(st, sid, act, payload)
WHERE NOT EXISTS (SELECT 1 FROM perm_backfill_plan p
  WHERE p.subject_type = v.st AND p.subject_id = v.sid AND p.action = v.act AND p.payload = v.payload::jsonb);`;
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'insforge', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
  return plan.length;
}

// Casdoor client_credentials（同 web/lib/sync/casdoor-client.ts 模式；仅 --live 路径使用，本 task 未演练真调）
let tokenCache = null;
async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
      client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
    }),
  });
  if (!resp.ok) throw new Error(`token fetch failed: ${resp.status}`);
  const data = await resp.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  return tokenCache.token;
}
async function casdoorFetch(path, opts = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`${CASDOOR_API}${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!resp.ok) throw new Error(`casdoor_${resp.status}: ${await resp.text().catch(() => '')}`);
  return resp.json().catch(() => null);
}
// resource 勾选 = add-permission resources；挂组 = update-user Groups（经 maps_branch_group 的 group_id 语义，此处按 group_name 展示）
async function casdoorApplyOne(row) {
  if (row.action === 'grant-resource') {
    return casdoorFetch('/api/add-permission', { method: 'POST', body: JSON.stringify({ resourceName: row.payload.key }) });
  }
  if (row.action === 'attach-group') {
    return casdoorFetch('/api/update-user', { method: 'POST', body: JSON.stringify({ owner: CASDOOR_ORG, name: row.subject_id, groups: [row.payload.group] }) });
  }
  throw new Error(`manual-review 行禁止自动 apply（人工核对）：${row.subject_id}`);
}

function usage() {
  console.error(`Usage: backfill-perms.mjs --plan-only [--write] | --apply [--live] | --diff-only --claims <file>
  --plan-only  读 perm_freeze_snapshot → 推导回填 plan 打印（不执行）；--write 落 perm_backfill_plan（幂等去重）
  --apply      按工作台 pending 行执行；默认 mock（只打印将调的 Casdoor 动作）；--live 真调（需 CASDOOR_CLIENT_ID/SECRET）
  --diff-only  逐用户四维 diff（claims 派生 vs 冻结快照）；--claims=<file> JSON 数组
               [{ user, brands, categories, branch_nums, can_see_cost }]（branch_nums 由调用方从 groups 派生）
               退出码 0 = diff 全零（B4 门禁）；快照 role/dept 行不参与（其投影经 claims 构建器落到用户维度）`);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => ['--plan-only', '--apply', '--diff-only'].includes(a));
  const claimsArg = argv.find((a) => a.startsWith('--claims'));
  if (!mode) { usage(); process.exit(1); }

  if (mode === '--plan-only') {
    const snapshot = readSnapshot();
    const groupMap = readGroupMap();
    const unmapped = new Set();
    const plan = planBackfill(snapshot, { groupOf: (bn) => groupMap.get(bn) ?? (unmapped.add(bn), null) });
    // CLI 层策略：映射不到组的门店无法自动挂 → 转人工核对（纯函数语义不变）
    for (const p of plan) {
      if (p.action === 'attach-group' && p.payload.group == null) {
        p.action = 'manual-review';
        p.payload = { reason: 'no-group-mapping', branch_number: p.payload.branch_number, note: 'maps_branch_group 无 active store 映射，人工定组' };
      }
    }
    const byAction = plan.reduce((m, p) => ((m[p.action] = (m[p.action] ?? 0) + 1), m), {});
    console.error(`[backfill] 快照 ${snapshot.length} 主体 → plan ${plan.length} 行：${JSON.stringify(byAction)}`);
    if (unmapped.size) console.error(`[backfill] ⚠️ ${unmapped.size} 个 branch_number 无组映射（已转 manual-review）：${[...unmapped].slice(0, 5).join(', ')}${unmapped.size > 5 ? ' …' : ''}`);
    console.log(JSON.stringify(plan, null, 2));
    if (argv.includes('--write')) {
      const n = writePlan(plan);
      console.error(`[backfill] --write：新插入 ${n} 行候选（去重后以库内计数为准），perm_backfill_plan status=pending`);
    }
    return;
  }

  if (mode === '--apply') {
    const pending = psqlJson(`SELECT coalesce(json_agg(t), '[]'::json) FROM (
      SELECT id, subject_type, subject_id, action, payload FROM perm_backfill_plan WHERE status = 'pending' ORDER BY id) t`);
    if (!pending.length) { console.error('[backfill] 无 pending 行（先 --plan-only --write）'); process.exit(1); }
    const live = argv.includes('--live');
    if (live && (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET)) {
      console.error('[backfill] --live 需 CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET（W4 演练时接通）'); process.exit(2);
    }
    console.error(`[backfill] ${live ? 'LIVE（真调 Casdoor）' : 'MOCK（只打印，不真调）'}：${pending.length} 行 pending`);
    for (const row of pending) {
      if (row.action === 'manual-review') { console.error(`[backfill] 跳过 manual-review（人工核对）：${row.subject_id} #${row.id}`); continue; }
      if (!live) { console.log(JSON.stringify({ mock: true, ...row })); continue; }
      try {
        await casdoorApplyOne(row);
        psqlMark(row.id, 'applied', null);
      } catch (e) {
        psqlMark(row.id, 'failed', e.message);
      }
    }
    if (!live) console.error('[backfill] mock 完成（本 task 不真调 Casdoor；--live 演练属 W4 后续）');
    return;
  }

  // --diff-only：B4 门禁核心，退出码 0 = 逐用户 diff 全零
  if (!claimsArg) { usage(); process.exit(1); }
  const claimsFile = claimsArg.includes('=') ? claimsArg.split('=')[1] : argv[argv.indexOf(claimsArg) + 1];
  const claims = JSON.parse(readFileSync(claimsFile, 'utf8'));
  const snapshot = readSnapshot();
  const snapUsers = new Map(snapshot.filter((r) => r.subject_type === 'user').map((r) => [r.subject_id, r]));
  const claimsUsers = new Map(claims.map((c) => [c.user, c]));
  const diffs = [];
  for (const [uid, snap] of snapUsers) {
    const c = claimsUsers.get(uid);
    if (!c) { diffs.push({ user: uid, dim: 'subject-coverage', missing: [], extra: ['<claims 未覆盖该用户>'] }); continue; }
    const d = diffScope(c, snap);
    if (d.length) diffs.push({ user: uid, diffs: d });
  }
  for (const uid of claimsUsers.keys()) {
    if (!snapUsers.has(uid)) diffs.push({ user: uid, dim: 'subject-coverage', missing: ['<快照无该用户>'], extra: [] });
  }
  console.error(`[backfill] diff 门禁：快照 user ${snapUsers.size} × claims ${claimsUsers.size} → 差异用户 ${diffs.length}${diffs.length ? '' : '（全零 ✅）'}`);
  console.log(JSON.stringify({ gate: diffs.length ? 'FAIL' : 'PASS', diffUsers: diffs.length, diffs }, null, 2));
  process.exit(diffs.length ? 1 : 0);
}

function psqlMark(id, status, error) {
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'insforge', '-v', 'ON_ERROR_STOP=1',
    '-c', `UPDATE perm_backfill_plan SET status='${status}', error=${error ? q(error) : 'NULL'} WHERE id=${id}`],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

// 入口守卫：被 import（如 node:test）时不跑 CLI，只有直接执行才进 main
const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  main().catch((e) => { console.error('[backfill] Fatal:', e.message); process.exit(2); });
}
