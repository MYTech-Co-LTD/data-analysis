// scripts/tests/perm-sunset.test.mjs
// W6 / Task 20（B6+H11+H9 收口）：data_permissions sunset 生效断言。
// 跑法：node --test scripts/tests/perm-sunset.test.mjs（目标容器 deploy-postgres-1——本地 dev 与生产同名）。
//
// harness 适配（同 rls-branch-policy / exception-rls-union 勘误先例）：
//  - psql -tAc 多语句输出 BEGIN / set_config 回显 / 目标值 / ROLLBACK，取倒数第二行（目标值）；
//  - plan 原文 claim_match_or_star 断言签名写 (text,text)，实测真身是 (jsonb,text)
//    （pg_get_function_identity_arguments 取证；183 迁移头同款勘误），按真签名断言；
//  - plan §③ 的 perms_input 钉死在 185 内已改为 to_regclass 守卫 DO 块（原文 NOT EXISTS(行) 语义
//    = 有冻结行永不钉死 + 二跑即 relation 报错，非幂等），测试断言语义不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();

function withClaims(claimsJson, sql) {
  const out = PSQL(
    `BEGIN; SELECT set_config('request.jwt.claims', '${JSON.stringify(claimsJson).replace(/'/g, "''")}', true); ${sql}; ROLLBACK;`
  );
  const lines = out.trim().split('\n').filter(Boolean);
  return lines[lines.length - 2];
}

test('绿：data_permissions 已删（sunset 生效）', () => {
  assert.equal(PSQL(`SELECT to_regclass('public.data_permissions') IS NULL`), 't');
});

test('绿：claim_match_or_star 已删且无任何策略引用', () => {
  // 真实签名 (jsonb,text)（072 CREATE OR REPLACE 参数 p_claim JSONB, p_value TEXT）
  assert.equal(PSQL(`SELECT to_regprocedure('claim_match_or_star(jsonb,text)') IS NULL`), 't');
  const refs = PSQL(`SELECT count(*) FROM pg_policies WHERE qual LIKE '%claim_match_or_star%' OR with_check LIKE '%claim_match_or_star%'`);
  assert.equal(refs, '0');
});

test('绿：scope_match_v2 终版——无 data_scope 段（旧形状令牌）也 deny（回退支已删，B1 全量）', () => {
  const r = withClaims({ sub: 'shanhai/legacy-shape' },
    `SELECT scope_match_v2('branch_nums', '3120-001')`);
  assert.equal(r, 'f');
  // 旧形状的 072 宽松支形态（顶层空数组）同样 deny——S4 豁免窗口关闭
  const rEmpty = withClaims({ sub: 'shanhai/legacy-shape', branch_nums: [] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`);
  assert.equal(rEmpty, 'f');
});

test('绿：can_cost_visible 终版——旧顶层 can_see_cost 不再回退（fields 段唯一判定源）', () => {
  const r = withClaims({ sub: 'shanhai/x', can_see_cost: true },
    `SELECT can_cost_visible()`);
  assert.equal(r, 'f');   // 旧 key 镜像摘除后，无 fields 段 = 全掩（安全方向）
});

test('绿：perm_freeze_snapshot 保留（回滚保险 + 审计）', () => {
  assert.equal(PSQL(`SELECT to_regclass('public.perm_freeze_snapshot') IS NOT NULL`), 't');
  assert.equal(PSQL(`SELECT to_regclass('public.perm_freeze_sentinel') IS NOT NULL`), 't');
});

test('绿：输入开关钉死 casdoor + sunset 旗标就位（③ to_regclass 守卫版）', () => {
  assert.equal(PSQL(`SELECT value FROM system_flags WHERE key='perms_input'`), 'casdoor');
  assert.equal(PSQL(`SELECT value FROM system_flags WHERE key='data_permissions_sunset'`), 'done');
});

test('绿：get_user_perms 终版（casdoor-only）不炸且形状完整——无 data_permissions 依赖', () => {
  // 未知用户（NOT FOUND 分支，现状语义保留）也要返回完整 JSONB——终版内核只读
  // org_users/roles/maps_branch_group/temporary_grants，无已删表引用。
  const j = PSQL(`SELECT get_user_perms('shanhai/sunset-probe')::text`);
  const o = JSON.parse(j);
  for (const k of ['role_code', 'branch_nums', 'brands', 'categories', 'can_see_cost',
    'default_landing', 'default_metric', 'visible_panels']) {
    assert.ok(k in o, `缺 key: ${k}`);
  }
  // strict 终版：未知用户 fail-close NULL
  assert.equal(PSQL(`SELECT get_user_perms_strict('shanhai/sunset-probe') IS NULL`), 't');
});

test('绿：shadow diff 双副本已删（双氧期结束，job 由 sunset 旗标 no-op）', () => {
  // 真实参数类型 character varying（175 §③④ CREATE 用 VARCHAR——其自身 DROP (TEXT) 恒 miss，取证修正）
  assert.equal(PSQL(`SELECT to_regprocedure('get_user_perms_legacy(character varying)') IS NULL`), 't');
  assert.equal(PSQL(`SELECT to_regprocedure('get_user_perms_casdoor(character varying)') IS NULL`), 't');
});

test('绿：freeze_perms sunset 桩——表已删时调用即明确报错（禁静默/禁模糊 relation 错误）', () => {
  let msg = '';
  try { PSQL(`SELECT freeze_perms()`); } catch (e) { msg = String(e.stderr ?? e.message); }
  assert.ok(/sunset|167_reverse/.test(msg), `应报 sunset 引导错误，实际: ${msg.slice(0, 300)}`);
});
