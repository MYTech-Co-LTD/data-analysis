// scripts/tests/reconcile-groups.test.mjs
// Task 10 Step 1（plan 2026-08-16-platform-iam-standardization.md L1032-1073 逐字基线）。
// 覆盖：成员级 per-user diff（E 红双向）/ 白名单豁免（人工审批+审计留痕）/ 7 天门禁（M4，W2 退出判据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMembershipDiff, gate7days } from '../reconcile-groups.mjs';

test('成员级 diff：用户在期望源有店 A 但挂组展开无 A → E 级红（per-user 粒度）', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'zhangsan', branch_numbers: ['3120-001', '3120-002'] }],
    actual:   [{ user: 'zhangsan', branch_numbers: ['3120-001'] }],
    whitelist: [],
  });
  assert.equal(d.red.length, 1);
  assert.equal(d.red[0].user, 'zhangsan');
  assert.equal(d.red[0].missing[0], '3120-002');
});

test('白名单条目豁免（人工审批挂组）：diff 命中白名单 → 不算红、单列 whitelistHits', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'lisi', branch_numbers: ['3120-005'] }],
    actual:   [{ user: 'lisi', branch_numbers: [] }],
    whitelist: [{ user: 'lisi', branch_number: '3120-005', reason: '督导跨区', approvedBy: 'boss', approvedAt: '2026-08-20' }],
  });
  assert.equal(d.red.length, 0);
  assert.equal(d.whitelistHits.length, 1);
});

test('多挂（实际比期望多店）→ E 级红（越权方向）', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'wang', branch_numbers: ['3120-001'] }],
    actual:   [{ user: 'wang', branch_numbers: ['3120-001', '64188-001'] }],
    whitelist: [],
  });
  assert.equal(d.red[0].extra[0], '64188-001');
});

test('7 天门禁判定：连续 7 天白名单外 diff=0 才 pass', () => {
  const gate = (history) => history.slice(-7).length === 7 && history.slice(-7).every((h) => h.whitelistOutsideDiff === 0 && h.redCount === 0);
  assert.equal(gate(Array.from({ length: 7 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 }))), true);
  assert.equal(gate([{ whitelistOutsideDiff: 0, redCount: 0 }, ...Array.from({ length: 6 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 }))].concat([{ whitelistOutsideDiff: 2, redCount: 1 }])), false);
  // gate7days 导出与内联语义一致（供 cron 查询 group_reconcile_history 用）
  assert.equal(gate7days(Array.from({ length: 7 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 }))), true);
  assert.equal(gate7days([{ whitelistOutsideDiff: 0, redCount: 0 }, ...Array.from({ length: 6 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 })), { whitelistOutsideDiff: 2, redCount: 1 }]), false);
});
