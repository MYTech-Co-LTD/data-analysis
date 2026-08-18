#!/usr/bin/env node
// scripts/migrate-store-scope.mjs
// ⚠ 2026-08-18 已废弃（用户裁定）：本脚本生成「一个数据范围 = 一个 scope-<user> permission」，
//   与最终形态（范围|X 资源直接挂现有 permission.resources）相悖。scope-<user> 已由管理员删除。
//   保留仅作存量对账/历史参考，勿再 --apply。
//
// 2026-08-18 门店范围显式授权（P2）：存量迁移 + 例外合并 + 全量比对报表（历史实现，已废弃）。
//
// 做什么：
//   1. 遍历 Casdoor org 用户，按【旧逻辑】（token groups + maps_branch_group）算当前生效 branch 集
//   2. 反向打包：优先用用户自身的组名当「范围包」（语义等价）；全店覆盖 → 范围|全店；
//      例外 temporary_grants 活跃记录并入（fields→字段|成本可见 等，中文资源名）
//   3. 生成/更新 Casdoor permission `scope-<用户名>` 直挂用户（幂等：已存在则覆写 resources）
//   4. 比对报表：新逻辑（resolveScopeKeys 解析范围资源）vs 旧逻辑逐用户集合比对，DIFF 则 exit 1
//
// 用法：
//   node scripts/migrate-store-scope.mjs            # dry-run（默认）：只出报表
//   node scripts/migrate-store-scope.mjs --apply    # 写 Casdoor
// env：DATABASE_URL（prod，可走 SSH 隧道）+ CASDOOR_CLIENT_ID/SECRET（client_credentials）
//
// 注意：
//   - 例外迁移后人控语义（无到期）：temporary_grants 表保留不删（回滚依据），只停写
//   - 范围|<门店中文名> 优先，branch_number 兜底；包名直接用企微组名（本就是中文）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';
const DATABASE_URL = process.env.DATABASE_URL || '';

// 品牌 sbc ↔ 中文资源名（与 claims.js FRIENDLY_TO_KEY 同源；此处反向）
const SBC_TO_BRAND_RES = { '3120': '品牌|熊喵鲜生', '64188': '品牌|品品甜' };

if (!DATABASE_URL || !CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
  console.error('❌ 缺 env：DATABASE_URL / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET');
  process.exit(2);
}

// ── DB（经 postgrest 风格 pg 直连；复用 pg 依赖）──
const { default: pg } = await import(`${ROOT}/services/semantic-generator/node_modules/pg/lib/index.js`);
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function q(sql) {
  const r = await pool.query(sql);
  return r.rows;
}

// ── Casdoor client_credentials（同 scripts/reconcile-catalog.mjs 模式）──
async function getAccessToken() {
  const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
      client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
    }),
  });
  if (!resp.ok) throw new Error(`token fetch ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('no access_token');
  return data.access_token;
}
async function casdoor(token, path, method = 'GET', body) {
  const resp = await fetch(`${CASDOOR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status} ${text.slice(0, 200)}`);
  return j;
}

// ── 旧逻辑展开（与 claims.js resolveGroupBranches 语义一致，脚本内联防跨包依赖）──
function legacyExpand(groupPaths, maps, knownDepts) {
  const results = new Set();
  for (const path of groupPaths ?? []) {
    const g = String(path).split('/').pop();
    const rows = maps.filter((m) => m.group_id === g && m.branch_number);
    if (rows.length > 0) { rows.forEach((m) => results.add(m.branch_number)); continue; }
    const asRegion = maps.some((m) => m.group_type === 'store' && m.group_id.startsWith(g + '-'));
    if (asRegion) {
      maps.filter((m) => m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number)
        .forEach((m) => results.add(m.branch_number));
      continue;
    }
    if (knownDepts.has(g)) continue;
    return { ok: false, error: `unknown group: ${g}` };
  }
  return { branch_nums: [...results].sort(), ok: true };
}

// ── 新逻辑解析（与 claims.js resolveScopeKeys 语义一致）──
function resolveScopeKeys(scopeKeys, maps, dimBranches) {
  const results = new Set();
  const byGroup = new Map();
  for (const m of maps) {
    if (!m.group_id || !m.branch_number) continue;
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m.branch_number);
  }
  const branchNums = new Set(maps.map((m) => m.branch_number).filter(Boolean));
  const byName = new Map();
  for (const d of dimBranches) {
    if (!d.branch_name || !d.branch_number) continue;
    if (!byName.has(d.branch_name)) byName.set(d.branch_name, []);
    byName.get(d.branch_name).push(d.branch_number);
  }
  for (const raw of scopeKeys) {
    const key = String(raw);
    if (key === '*' || key === '全店') return { branch_nums: ['*'], ok: true };
    const pack = byGroup.get(key);
    if (pack) { pack.forEach((b) => results.add(b)); continue; }
    if (branchNums.has(key)) { results.add(key); continue; }
    const named = byName.get(key);
    if (named && named.length === 1) { results.add(named[0]); continue; }
    if (named && named.length > 1) return { ok: false, error: `ambiguous store name: ${key}` };
    return { ok: false, error: `unknown scope key: ${key}` };
  }
  return { branch_nums: [...results].sort(), ok: true };
}

const eqSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// ── main ──
const maps = await q(`select group_id, group_type, branch_number from maps_branch_group where is_active`);
const dimBranches = await q(`select branch_number, branch_name from dim_branch`);
const deptRows = await q(`select name from org_departments where is_active`);
const knownDepts = new Set(deptRows.map((d) => d.name));
const tempGrants = await q(`select user_id, dim, value, granted_by, note from temporary_grants
  where revoked_at is null and expires_at > now()`);
const universe = [...new Set(maps.map((m) => m.branch_number).filter(Boolean))].sort();

const token = await getAccessToken();
const users = await casdoor(token, `/api/get-users?owner=${encodeURIComponent(CASDOOR_ORG)}&limit=1000`);
const userList = (Array.isArray(users) ? users : users.data ?? []);
const existingPerms = await casdoor(token, `/api/get-permissions?owner=${encodeURIComponent(CASDOOR_ORG)}`);
const permList = (Array.isArray(existingPerms) ? existingPerms : existingPerms.data ?? []);

const nameToBranch = new Map();
for (const d of dimBranches) if (d.branch_name && d.branch_number) nameToBranch.set(d.branch_name, d.branch_number);
const branchToName = new Map();
for (const d of dimBranches) if (d.branch_name && d.branch_number && !branchToName.has(d.branch_number)) branchToName.set(d.branch_number, d.branch_name);

const report = [];
let diffCount = 0;

for (const u of userList) {
  if (!u.name || u.name === 'admin') continue;
  const groups = Array.isArray(u.groups) ? u.groups : [];

  // 旧逻辑
  const legacy = legacyExpand(groups, maps, knownDepts);
  if (!legacy.ok) {
    report.push({ user: u.name, status: 'LEGACY-FAIL', detail: legacy.error, scopes: [] });
    diffCount++;
    continue;
  }
  const legacySet = legacy.branch_nums;
  const coversAll = legacySet.length > 0 && eqSet(legacySet, universe);

  // 反向打包：全店 → 范围|全店；否则用用户自身组名（dept 包）
  const scopeResources = [];
  if (coversAll) {
    scopeResources.push('范围|全店');
  } else {
    for (const g of groups) {
      const gid = String(g).split('/').pop();
      const hasPack = maps.some((m) => m.group_id === gid && m.branch_number);
      if (hasPack) scopeResources.push(`范围|${gid}`);
    }
    // 旧形态（store 组）兜底：组名无包 → 用包内门店的中文名/编号
    if (scopeResources.length === 0 && legacySet.length > 0) {
      for (const b of legacySet) scopeResources.push(`范围|${branchToName.get(b) ?? b}`);
    }
  }

  // 例外合并（人控语义，无到期）
  const userGrants = tempGrants.filter((g) => g.user_id === u.name);
  const grantRes = [];
  const grantNote = [];
  for (const g of userGrants) {
    if (g.dim === 'fields' && g.value === 'cost') grantRes.push('字段|成本可见');
    else if (g.dim === 'brands' && SBC_TO_BRAND_RES[g.value]) grantRes.push(SBC_TO_BRAND_RES[g.value]);
    else if (g.dim === 'categories') grantRes.push(`品类|${g.value}`);
    else if (g.dim === 'branch_nums') grantRes.push(`范围|${branchToName.get(g.value) ?? g.value}`);
    else continue;
    grantNote.push(`${g.dim}:${g.value}(${g.granted_by}${g.note ? ' · ' + g.note : ''})`);
  }

  const resources = [...new Set([...scopeResources, ...grantRes])];

  // 新逻辑复算（范围资源部分）
  const scopeKeys = scopeResources.map((r) => r.slice('范围|'.length));
  const neo = scopeKeys.length === 0
    ? { branch_nums: [], ok: true }
    : resolveScopeKeys(scopeKeys, maps, dimBranches);
  const neoSet = neo.ok ? (neo.branch_nums.length === 1 && neo.branch_nums[0] === '*'
    ? (eqSet(universe, universe) ? universe : neo.branch_nums) : neo.branch_nums) : [];

  const equal = neo.ok && eqSet(neoSet, legacySet);
  if (!equal) diffCount++;
  report.push({
    user: u.name, display: u.displayName ?? '',
    status: !neo.ok ? 'RESOLVE-FAIL' : equal ? 'EQUAL' : 'DIFF',
    detail: !neo.ok ? neo.error : equal ? '' :
      `legacy ${legacySet.length} 店 vs new ${neoSet.length} 店`,
    scopes: scopeResources, grants: grantRes,
    permission: `scope-${u.name}`,
    resources,
  });
}

// ── 输出 ──
console.log(`\n===== 迁移报表（${APPLY ? 'APPLY' : 'DRY-RUN'}）=====`);
console.log(`用户 ${report.length} · 例外活跃 ${tempGrants.length} 条 · DIFF/FAIL ${diffCount} 人\n`);
for (const r of report) {
  const mark = r.status === 'EQUAL' ? '✓' : '✗';
  console.log(`${mark} ${r.user}${r.display ? `（${r.display}）` : ''} [${r.status}] ${r.detail}`);
  if (r.scopes.length) console.log(`    范围资源: ${r.scopes.join(' · ')}`);
  if (r.grants.length) console.log(`    例外并入: ${r.grants.join(' · ')}`);
}

if (APPLY) {
  for (const r of report) {
    if (r.status === 'RESOLVE-FAIL') { console.error(`⏭ 跳过 RESOLVE-FAIL：${r.user}`); continue; }
    const payload = {
      owner: CASDOOR_ORG,
      name: r.permission,
      displayName: `数据范围-${r.display || r.user}`,
      users: [`${CASDOOR_ORG}/${r.user}`],
      roles: [],
      groups: [],
      resources: r.resources,
      actions: ['Read'],
      effect: 'Allow',
      state: 'Approved',
      description: `门店范围显式授权迁移 2026-08-18${r.grants.length ? '（含例外并入）' : ''}`,
      valueType: 'STRING', ifAll: false, subDomains: [],
    };
    const exists = permList.find((p) => p.name === r.permission);
    const res = exists
      ? await casdoor(token, `/api/update-permission?id=${encodeURIComponent(`${CASDOOR_ORG}/${r.permission}`)}`, 'POST', payload)
      : await casdoor(token, '/api/add-permission', 'POST', payload);
    const ok = res === 'Affected' || res?.data === 'Affected' || res === true;
    console.log(`${ok ? '✅' : '⚠️'} ${exists ? 'update' : 'add'} ${r.permission} → ${JSON.stringify(res).slice(0, 80)}`);
  }
} else {
  console.log('\n（dry-run：未写 Casdoor。--apply 执行写入）');
}

await pool.end();
if (diffCount > 0) {
  console.error(`\n❌ ${diffCount} 个用户 DIFF/FAIL——修复后再 --apply`);
  process.exit(1);
}
console.log('\n✅ 全量集合相等');
