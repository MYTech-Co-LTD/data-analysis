// scripts/tests/backfill-perms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, diffScope } from '../backfill-perms.mjs';

test('快照→回填计划：品牌/品类维 → resource 勾选动作；门店维 → 挂组动作；cost → field:cost', () => {
  const plan = planBackfill([{
    subject_type: 'user', subject_id: 'shanhai/zhangsan',
    brands: ['3120'], categories: ['水果'], branch_nums: ['3120-001', '3120-002'], can_see_cost: true,
  }], { groupOf: (bn) => `熊喵-${bn}` });
  const z = plan.filter((p) => p.user_id === 'shanhai/zhangsan');
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:brand:3120'));
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:category:水果'));
  assert.ok(z.some((p) => p.action === 'attach-group' && p.payload.group === '熊喵-3120-001'));
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:field:cost'));
});

test('通配 ["*"] 门店集合 → 不逐店挂组，标 wildcard 人工核对（禁 250 组批量挂）', () => {
  const plan = planBackfill([{
    subject_type: 'role', subject_id: 'boss', brands: [], categories: [], branch_nums: ['*'], can_see_cost: true,
  }], { groupOf: () => 'x' });
  const b = plan.filter((p) => p.subject_id === 'boss');
  assert.ok(b.every((p) => p.action !== 'attach-group'));
  assert.ok(b.some((p) => p.action === 'manual-review' && p.payload.reason === 'wildcard-branch'));
});

test('diffScope：逐用户四维 diff（claims 派生 vs 冻结快照），全等 = 空数组', () => {
  const d = diffScope(
    { user: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: ['3120-001', '3120-002'], can_see_cost: true },
    { subject_id: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: ['3120-002', '3120-001'], can_see_cost: true },
  );
  assert.deepEqual(d, []);   // 顺序无关（集合语义）
  const d2 = diffScope(
    { user: 'shanhai/zhangsan', brands: ['3120'], categories: [], branch_nums: [], can_see_cost: false },
    { subject_id: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: [], can_see_cost: false },
  );
  assert.deepEqual(d2, [{ dim: 'categories', missing: [], extra: ['水果'] }]);   // B4 门禁报差异
});
