// scripts/tests/roles-contract-sunset.test.mjs
// H11 契约①替代（W6 / Task 20）：08-15 契约①（Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}）
// 依赖的表已删 → 替代契约 = Casdoor roles ⊆ 期望源（org_users.role_codes 镜像 = Group tree 成员登录时
// 写穿的 role 码，index.js role_codes mirror；∪ {admin} 常量）差分期望集。
//
// 两段式（同 reconcile-catalog.test.mjs 先例——纯函数段 + env 门控 live 段）：
//  - 纯函数段：差分探测器 fixture 红/绿（无外部依赖，恒可跑）；
//  - live 段：真调 Casdoor（client_credentials，与 scripts/reconcile-catalog.mjs /
//    web/lib/sync/casdoor-client.ts 同款 env：CASDOOR_API_URL/CLIENT_ID/CLIENT_SECRET/ORG）。
//    本地无 env 自动 skip；生产侧可跑：ssh 服务器 source deploy/.env 后
//    node --test scripts/tests/roles-contract-sunset.test.mjs（read-only：get-roles + 本地 psql）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// 差分探测器（纯）：Casdoor 全量 role name 中，不在期望源（镜像 role_codes ∪ {admin}）内的孤儿
export function diffRolesContract(casdoorRoles, expectSet) {
  const expect = expectSet instanceof Set ? expectSet : new Set([...(expectSet ?? []), 'admin']);
  if (!expect.has('admin')) expect.add('admin');        // admin 非 roles 表行（env 常量），恒放行
  return [...new Set(casdoorRoles ?? [])].filter((r) => !expect.has(r));
}

test('纯逻辑：全部映射 + admin → 差分为空（契约绿）', () => {
  const missing = diffRolesContract(['boss', 'manager', 'admin'], new Set(['boss', 'manager']));
  assert.deepEqual(missing, []);
});

test('纯逻辑：孤儿 role（期望源无映射）→ 差分非空（契约红）', () => {
  const missing = diffRolesContract(['boss', 'ghost_role', 'admin'], new Set(['boss']));
  assert.deepEqual(missing, ['ghost_role']);
});

test('纯逻辑：去重（Casdoor 重复返回不误报）+ 空期望源仅剩 admin 放行', () => {
  assert.deepEqual(diffRolesContract(['admin', 'admin'], new Set()), []);
  assert.deepEqual(diffRolesContract(['x'], new Set()), ['x']);
});

// ---- live 段（env 门控；无 env skip——差分真值在生产侧跑） ----
const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';
const LIVE = Boolean(CASDOOR_CLIENT_ID && CASDOOR_CLIENT_SECRET);

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();

test('live：Casdoor roles ⊆ Group tree 成员 role_codes 镜像 ∪ {admin}（差分非空即红）', { skip: LIVE ? false : '缺 CASDOOR_CLIENT_ID/SECRET（生产侧 source deploy/.env 后跑）' }, async () => {
  // ① token（client_credentials——reconcile-catalog.mjs 同款，DW1 勘误 #4：失败 throw 归一）
  const tResp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
      client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
    }),
  });
  if (!tResp.ok) throw new Error(`token fetch failed: ${tResp.status}`);
  const { access_token } = await tResp.json();
  if (!access_token) throw new Error('token response missing access_token');

  // ② Casdoor 全量 role name
  const rResp = await fetch(`${CASDOOR_API}/api/get-roles?owner=${encodeURIComponent(CASDOOR_ORG)}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!rResp.ok) throw new Error(`get-roles failed: ${rResp.status}`);
  const rData = await rResp.json();
  const casdoorRoles = (Array.isArray(rData?.data) ? rData.data : [])
    .map((r) => r?.name).filter((n) => typeof n === 'string' && n);
  assert.ok(casdoorRoles.length > 0, `get-roles 返回空（owner=${CASDOOR_ORG}）——契约无从谈起`);

  // ③ 期望源：org_users.role_codes（登录写穿的 Group tree 成员镜像；treat NULL/空安全）
  const mirror = PSQL(`SELECT DISTINCT unnest(role_codes) FROM org_users WHERE is_active AND role_codes IS NOT NULL AND role_codes <> '{}'`);

  const missing = diffRolesContract(casdoorRoles, new Set(mirror ? mirror.split('\n') : []));
  assert.deepEqual(missing, [], `Casdoor 存在无期望源映射的 role: ${missing.join(', ')}`);
});
