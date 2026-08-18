// scripts/tests/scope-key-normalize.test.mjs
// 迁移 186 的红→绿注入测试：scope_match_v2 门店复合键尾段前导零归一。
//
// 背景（2026-08-17 生产实测定位）：gen 视图对门店列传裸 branch_num（'58'）或
// 不补零复合（system_book_code || '-' || branch_num = '3120-58'）；而 PR#13 后
// claims.branch_nums 来自 maps_branch_group.branch_number = dim_branch 规范补零复合
// （'3120-0058'）→ 形态漂移 → 报表 actuals 全空。
// 修复语义：比较双侧对「含 '-' 且尾段为纯数字」的值做去前导零归一（'3120-0058' ≡ '3120-58'）；
// 裸值（无 '-'）与 brands 维（'3120'）不动；通配 '*' 不动。
//
// 断言经 scope_match_v2 直判（同 rls-branch-policy.test.mjs 模式，testing-handbook §2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' });

function withClaims(claimsJson, sql, grantsJson) {
  const grantSet = grantsJson
    ? `SELECT set_config('request.jwt.claims.x_grants', '${JSON.stringify(grantsJson).replace(/'/g, "''")}', true); `
    : '';
  const out = PSQL(
    `BEGIN; SELECT set_config('request.jwt.claims', '${JSON.stringify(claimsJson).replace(/'/g, "''")}', true); ` +
    `${grantSet}${sql}; ROLLBACK;`
  );
  const lines = out.trim().split('\n').filter(Boolean);
  return lines[lines.length - 2];
}

const sm = (claims, col, grants) => withClaims(claims, `SELECT scope_match_v2('branch_nums', '${col}')`, grants);
const smBrand = (claims, col) => withClaims(claims, `SELECT scope_match_v2('brands', '${col}')`);

test('绿：补零复合 claims × 不补零复合列（视图实际形态）→ 放行【迁移 186 核心目标】', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-0058'] } }, '3120-58'), 't');
});

test('绿：反向——不补零 claims × 补零列（dim 侧列）→ 放行（双侧归一）', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-58'] } }, '3120-0058'), 't');
});

test('绿：归一只去尾段前导零，不外溢到其它门店/品牌前缀', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-0058'] } }, '3120-59'), 'f');
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-0058'] } }, '64188-58'), 'f');
});

test('绿：裸值语义不变（无 \'-\' 不归一，裸/复合两形态仍互不匹配）', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['58'] } }, '58'), 't');
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['58'] } }, '3120-0058'), 'f');
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-0058'] } }, '58'), 'f');
});

test('绿：brands 维不受影响（\'3120\' 无 \'-\'，精确匹配语义保持）', () => {
  assert.equal(smBrand({ sub: 'shanhai/t', data_scope: { brands: ['3120'] } }, '3120'), 't');
  assert.equal(smBrand({ sub: 'shanhai/t', data_scope: { brands: ['3120'] } }, '64188'), 'f');
});

test('绿：通配 "*" 语义保持', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['*'] } }, '3120-58'), 't');
});

test('绿：多零尾段全剥（\'3120-0005\' ≡ \'3120-5\' ≡ \'3120-05\'）', () => {
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-0005'] } }, '3120-5'), 't');
  assert.equal(sm({ sub: 'shanhai/t', data_scope: { branch_nums: ['3120-05'] } }, '3120-5'), 't');
});
