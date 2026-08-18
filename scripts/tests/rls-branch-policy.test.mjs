// scripts/tests/rls-branch-policy.test.mjs
// 迁移 179 的红→绿注入测试（M1 封口）：迁移前空 data_scope 声称 deny 的用户在新 RLS 下 0 行；
// 迁移前（红态断言）旧 RLS 对「顶层空数组」全放——本测试验证绿态。
// W6（Task 20 / 185）：legacy 回退支已摘——旧形状（无 data_scope 段）两例翻为 deny 断言（B1 全量生效）。
//
// 断言经 scope_match_v2 直判（不依赖具体表）；claims 经 set_config('request.jwt.claims', ...)
// 事务内注入（testing-handbook §2 本地参数化 claim 模式）。
//
// 注：psql -tAc 多语句会输出 BEGIN / set_config 回显 / 目标值 / ROLLBACK 共 4 行，
// 取倒数第二行（目标值）——plan 版直接 assert 整串会在绿态也恒假（harness 修正，断言语义不变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' });

function withClaims(claimsJson, sql) {
  const out = PSQL(
    `BEGIN; SELECT set_config('request.jwt.claims', '${JSON.stringify(claimsJson).replace(/'/g, "''")}', true); ${sql}; ROLLBACK;`
  );
  // 输出行：BEGIN / <set_config 回显 json> / <目标值> / ROLLBACK
  const lines = out.trim().split('\n').filter(Boolean);
  return lines[lines.length - 2];
}

test('绿：新形状（data_scope 存在且 branch_nums 空）→ 0 行（B1 空集=deny，不收敛 *)', () => {
  // 攻击背景：旧 RLS 对「顶层空数组」全放；新形状空段是 deny 语义载体，必须收敛为 deny。
  const ok = withClaims(
    { sub: 'shanhai/test', data_scope: { branch_nums: [] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 'f');                                        // 空=deny
});

test('绿：新形状含通配 ["*"] → 放行（通配语义保留）', () => {
  const ok = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['*'] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 't');
});

test('绿：新形状具体门店列表 → 精确命中放行', () => {
  // 直判模式 p_col 传行值样例（plan 版误传列名字符串 'branch_number'，与 data_scope 值永不相等）
  const ok = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['3120-001'] } },
    `SELECT scope_match_v2('branch_nums', '3120-001')`);
  assert.equal(ok, 't');
  // 负例：非授权门店值 → deny（精确匹配不外溢）
  const no = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['3120-001'] } },
    `SELECT scope_match_v2('branch_nums', '64188-001')`);
  assert.equal(no, 'f');
});

test('绿：legacy 形状（无 data_scope 段）→ deny（185 终版摘回退支——旧形状令牌不再回退 072，S4 豁免窗口已关）', () => {
  const okNull = withClaims({ sub: 'shanhai/test' },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);          // 顶层无 key → deny（旧 072 NULL→true 支已删）
  assert.equal(okNull, 'f');
  const okEmpty = withClaims({ sub: 'shanhai/test', branch_nums: [] },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);          // 顶层空数组 → deny（旧 072 空→true 宽松支已删）
  assert.equal(okEmpty, 'f');
});

test('绿：顶层旧 key 空数组 + data_scope 并存 → 走 data_scope 分支不受 072 污染（M1 核心攻击路径封口）', () => {
  // 攻击形态：实现者若按值一致性直觉在新 claims 写顶层空数组 → 072 路径全放；
  // 策略分支必须以 data_scope 存在性优先，072 不再被读到。
  const ok = withClaims({ sub: 'shanhai/test', branch_nums: [], data_scope: { branch_nums: [] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 'f');                                       // data_scope 分支赢 → deny
});
