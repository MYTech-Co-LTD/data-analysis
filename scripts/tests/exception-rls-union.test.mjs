// scripts/tests/exception-rls-union.test.mjs
// RT→RLS 通道（M3）：例外门店经 pgrst_pre_request 每请求并集进 x_grants GUC；
// scope_match_v2 读 data_scope ∪ x_grants。断言走函数直判（同 Task 12 测试模式）。
//
// 注（harness 修正，同 rls-branch-policy.test.mjs）：psql -tAc 多语句输出 BEGIN / set_config 回显×2 /
// 目标值 / ROLLBACK，取倒数第二行（目标值）——plan 版直接 assert 整串会在绿态也恒假。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' });

function withGuC(claims, grants, sql) {
  const out = PSQL(
    `BEGIN; ` +
    `SELECT set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', true); ` +
    `SELECT set_config('request.jwt.claims.x_grants', '${JSON.stringify(grants).replace(/'/g, "''")}', true); ` +
    `${sql}; ROLLBACK;`
  );
  // 输出行：BEGIN / <claims 回显> / <x_grants 回显> / <目标值> / ROLLBACK
  const lines = out.trim().split('\n').filter(Boolean);
  return lines[lines.length - 2];
}

test('并集：data_scope.branch_nums 空集（deny 基线）+ x_grants 例外 → 例外门店放行、例外外仍 deny', () => {
  const DENY = { sub: 'shanhai/test', data_scope: { branch_nums: [], brands: ['3120'] } };
  assert.equal(withGuC(DENY, { branch_nums: ['3120-001'] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 't');
  assert.equal(withGuC(DENY, { branch_nums: ['3120-001'] },
    `SELECT scope_match_v2('branch_nums', '3120-099')`), 'f');
});

test('并集：非空 data_scope 与 x_grants 合并（两侧都命中/仅一侧命中均放行）', () => {
  const c = { sub: 'shanhai/test', data_scope: { branch_nums: ['3120-001'] } };
  assert.equal(withGuC(c, { branch_nums: ['3120-002'] },
    `SELECT scope_match_v2('branch_nums', '3120-002')`), 't');   // 仅例外侧
  assert.equal(withGuC(c, { branch_nums: ['3120-002'] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 't');   // 仅 data_scope 侧
});

test('两侧全空 = deny（B1 不因例外通道放松）', () => {
  assert.equal(withGuC(
    { sub: 'shanhai/test', data_scope: { branch_nums: [] } }, { branch_nums: [] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 'f');
});

test('pre_request 实查过期/撤销行不注入（等价单测 pre_request 过滤谓词）', () => {
  // 注（harness 修正）：JSON.stringify 会把模板串里的换行转成字面 \n 传给 psql → 语法错误，
  // 与 Task 12 测试同款单行化处理（断言语义不变）。
  const out = PSQL(
    `BEGIN; INSERT INTO temporary_grants (user_id, dim, value, expires_at, granted_by) ` +
    `VALUES ('shanhai/probe', 'branch_nums', '3120-009', now() - interval '1 hour', 'probe') ` +
    `ON CONFLICT DO NOTHING; ` +
    `SELECT set_config('request.jwt.claims', '{"sub":"shanhai/probe","data_scope":{"branch_nums":[]}}', true); ` +
    `SELECT pgrst_pre_request(); ` +
    `SELECT current_setting('request.jwt.claims.x_grants', true); ROLLBACK;`
  );
  assert.ok(!out.includes('3120-009'), `过期例外不得注入 x_grants，实际: ${out}`);
});
