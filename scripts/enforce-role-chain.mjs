#!/usr/bin/env node
// scripts/enforce-role-chain.mjs
// 2026-08-18 三层模型存量清理（一次性，幂等，dry-run 默认）：
//   1. 建 test-role 角色（若不存在；承载测试权限）
//   2. 「测试」「测试02」permission：roles=['shanhai/test-role']、users=[]（清直挂）
//   3. test-role.users = 原测试权限直挂用户并集（ZhangDuo, YangWei）
//   4. role-zone_manager：users=[]（清 ZhengXin 直挂，他仍走 zone_manager 角色，授权不变）
// 用法：node scripts/enforce-role-chain.mjs            # dry-run：只出报表
//       node scripts/enforce-role-chain.mjs --apply    # 写 Casdoor
// env：CASDOOR_CLIENT_ID/SECRET（client_credentials）
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
  console.error('❌ 缺 env：CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET');
  process.exit(2);
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

const tok = await casdoor(null, '/api/login/oauth/access_token', 'POST', {
  grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
  client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
});
const token = tok.access_token;
if (!token) { console.error('❌ no access_token'); process.exit(2); }

// 全量 roles / permissions
const rolesBody = await casdoor(token, `/api/get-roles?owner=${encodeURIComponent(CASDOOR_ORG)}`);
const roles = Array.isArray(rolesBody) ? rolesBody : (rolesBody.data ?? []);
const permBody = await casdoor(token, `/api/get-permissions?owner=${encodeURIComponent(CASDOOR_ORG)}`);
const perms = Array.isArray(permBody) ? permBody : (permBody.data ?? []);
const getRole = (name) => roles.find((r) => r.name === name);

const report = [];
const roleFull = (name) => `${CASDOOR_ORG}/${name}`;

// ── 1. 建 test-role（若不存在）──
let testRole = getRole('test-role');
if (!testRole) {
  if (APPLY) {
    await casdoor(token, '/api/add-role', 'POST', {
      owner: CASDOOR_ORG, name: 'test-role', displayName: '测试角色',
      users: [], roles: [], isEnabled: true,
    });
    testRole = { name: 'test-role', users: [] };
  }
  report.push({ action: 'CREATE test-role', ok: APPLY, detail: APPLY ? '' : '（dry-run）' });
} else {
  report.push({ action: 'test-role 已存在', ok: true, detail: `users=${(testRole.users ?? []).length}` });
}

// ── 2/3. 测试权限：roles=[test-role]、清 users；直挂用户并入 test-role ──
const testPermNames = ['测试', '测试02'];
for (const pname of testPermNames) {
  const p = perms.find((x) => x.name === pname);
  if (!p) { report.push({ action: `permission ${pname}`, ok: false, detail: '不存在（跳过）' }); continue; }
  const directUsers = Array.isArray(p.users) ? p.users : [];
  const hasRole = (p.roles ?? []).map((r) => String(r)).includes(roleFull('test-role'));
  if (APPLY && (!hasRole || directUsers.length > 0)) {
    const nextUsers = APPLY ? [] : p.users;
    await casdoor(token, `/api/update-permission?id=${encodeURIComponent(`${CASDOOR_ORG}/${pname}`)}`, 'POST', {
      owner: CASDOOR_ORG, name: pname, displayName: p.displayName ?? pname,
      users: nextUsers, roles: [roleFull('test-role')], groups: p.groups ?? [],
      resources: p.resources ?? [], actions: p.actions ?? ['Read'],
      effect: p.effect ?? 'Allow', isEnabled: p.isEnabled ?? false,
    });
  }
  report.push({ action: `permission ${pname}`, ok: true, detail: `roles→[test-role]，users 清直挂（${directUsers.length} 人）` });
  for (const u of directUsers) {
    const bare = String(u).split('/').pop();
    report.push({ action: `  直挂用户 ${bare} → test-role`, ok: APPLY, detail: APPLY ? '' : '（dry-run）' });
  }
}

// test-role.users = 测试权限直挂用户并集
const testDirectUsers = [...new Set(perms
  .filter((p) => testPermNames.includes(p.name))
  .flatMap((p) => (Array.isArray(p.users) ? p.users : []))
  .map((u) => String(u)))];
if (APPLY && testDirectUsers.length > 0 && testRole) {
  const cur = Array.isArray(testRole.users) ? testRole.users.map((u) => String(u)) : [];
  const next = [...new Set([...cur, ...testDirectUsers])];
  await casdoor(token, `/api/update-role?id=${encodeURIComponent(roleFull('test-role'))}`, 'POST', {
    owner: CASDOOR_ORG, name: 'test-role', displayName: '测试角色', users: next, isEnabled: true,
  });
}

// ── 4. role-zone_manager：清 users（ZhengXin 直挂）──
const zm = getRole('zone_manager');
if (zm && (zm.users ?? []).length > 0) {
  const n = (zm.users ?? []).length;
  if (APPLY) {
    await casdoor(token, `/api/update-role?id=${encodeURIComponent(roleFull('zone_manager'))}`, 'POST', {
      owner: CASDOOR_ORG, name: 'zone_manager', displayName: zm.displayName ?? '', users: [], isEnabled: true,
    });
  }
  report.push({ action: 'role-zone_manager 清直挂 users', ok: APPLY, detail: `${n} 人（郑欣仍走 zone_manager 角色，授权不变）` });
} else {
  report.push({ action: 'role-zone_manager', ok: true, detail: '无直挂 users' });
}

// ── 报表 ──
console.log(`\n===== 三层模型存量清理（${APPLY ? 'APPLY' : 'DRY-RUN'}）=====`);
let fail = 0;
for (const r of report) {
  const mark = r.ok ? '✅' : '⚠️';
  if (!r.ok) fail++;
  console.log(`${mark} ${r.action} ${r.detail}`);
}
if (fail > 0) { console.error(`\n❌ ${fail} 项异常`); process.exit(1); }
console.log('\n✅ 完成');
