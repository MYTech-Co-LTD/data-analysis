// scripts/tests/perm-write-close.test.mjs
// H9（Task 18，迁移 184）：管理页只读只是 UX 表现 ≠ 单写者；DB 级 REVOKE + 触发器禁写 + 直写注入红转绿才放行 W6。
// 跑法：node --test scripts/tests/perm-write-close.test.mjs（目标容器 deploy-postgres-1——本地 dev 与生产同名）。
//
// harness 适配（同 exception-rls-union.test.mjs 勘误先例）：
//  - psql -tAc 多语句输出含 BEGIN / set_config 回显 / INSERT 0 n / 目标值 / ROLLBACK，取倒数第二行；
//  - SQL 一律单行（换行经 JSON.stringify 进 psql 会语法错误）；
//  - psql -c 单缓冲内任一语句失败 → 整缓冲中止、退出码非 0 → execSync 抛错 = 「被拒」判据。
// W6 sunset 守卫（Task 20）：data_permissions 已删（迁移 185）后，W5 窗口期的表级禁写探针失去标的
//  （表层被更强机制取代=表不存在本身）；保留可跑的探针（快照/哨兵禁写仍须成立——回滚保险不可污染），
//  表级探针改为断言「sunset 生效」，回滚演练窗口（167_reverse 后表在）则跑原红转绿断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();
// 直写注入（authenticated 角色 = PostgREST 写通道）：BEGIN 内注入，ROLLBACK 不留痕
const tryWrite = (sql) => PSQL(`BEGIN; SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"shanhai/inject","role":"admin"}', true); ${sql}; ROLLBACK;`);

// W6：表在 = 演练/回滚窗口（跑 W5 原断言）；表不在 = sunset 终态（断言更强机制）
const TABLE_EXISTS = PSQL(`SELECT to_regclass('public.data_permissions') IS NOT NULL`) === 't';

if (!TABLE_EXISTS) {
  test('绿(W6 终态)：data_permissions 已删——写通道标的消失本身即最强禁写（185 sunset）', () => {
    assert.equal(PSQL(`SELECT to_regclass('public.data_permissions') IS NULL`), 't');
  });
} else {
  test('绿：authenticated INSERT 直写被拒（触发器/REVOKE 双层）', () => {
    let threw = false;
    try { tryWrite(`INSERT INTO data_permissions (subject_type, subject_id) VALUES ('user','inject')`); }
    catch { threw = true; }
    assert.ok(threw, 'INSERT 须被 DB 层拒绝');
  });
}

test('绿：authenticated UPDATE/DELETE 直写被拒', () => {
  if (!TABLE_EXISTS) return;   // W6 终态：标的已删，W5 探针不适用
  for (const sql of [
    `UPDATE data_permissions SET note='x' WHERE id=(SELECT min(id) FROM data_permissions)`,
    `DELETE FROM data_permissions WHERE id=(SELECT min(id) FROM data_permissions)`,
  ]) {
    let threw = false;
    try { tryWrite(sql); } catch { threw = true; }
    assert.ok(threw, `${sql.slice(0, 6)} 须被 DB 层拒绝`);
  }
});

// 184 review 跟踪项（DW0 review #2）：pg_default_acl 给新表默认 arwd，快照/哨兵 authenticated 实际可 INSERT
// （180 触发器只封 UPDATE/DELETE）——伪造行污染冻结对账基线，184 一并 REVOKE。
test('绿：authenticated 直写 perm_freeze_snapshot/perm_freeze_sentinel 被拒', () => {
  for (const sql of [
    `INSERT INTO perm_freeze_sentinel (key, frozen_at) VALUES ('inject', now())`,
    `INSERT INTO perm_freeze_snapshot (subject_type, subject_id) VALUES ('user','inject')`,
  ]) {
    let threw = false;
    try { tryWrite(sql); } catch { threw = true; }
    assert.ok(threw, `${sql.slice(0, 40)} 须被 DB 层拒绝`);
  }
});

test('绿：逃生门 app.bypass_perm_write=on 可写（回滚脚本专用；写后即回滚不留痕）', () => {
  if (!TABLE_EXISTS) return;   // W6 终态：表已删，逃生门随标的消失（回滚脚本走 CREATE TABLE 路径）
  const out = PSQL(`BEGIN; SELECT set_config('app.bypass_perm_write', 'on', true); INSERT INTO data_permissions (subject_type, subject_id, note) VALUES ('user','rollback-probe','probe'); SELECT count(*) FROM data_permissions WHERE subject_id='rollback-probe'; ROLLBACK;`);
  // 输出行：BEGIN / on / INSERT 0 1 / 1 / ROLLBACK —— 目标值取倒数第二行
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines[lines.length - 2], '1');   // 逃生门开时可写（事务内验证即回滚）
});

test('绿：SELECT 不受影响（只读投影仍可读，167 回滚保险）', () => {
  if (!TABLE_EXISTS) return;   // W6 终态：只读投影随表删（见 perm-sunset.test.mjs 断言）
  const n = PSQL(`SELECT count(*) FROM data_permissions`);
  assert.ok(Number(n) >= 0);
});
