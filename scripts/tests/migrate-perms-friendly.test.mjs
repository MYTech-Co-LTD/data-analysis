// scripts/tests/migrate-perms-friendly.test.mjs
// 方案 C 生产迁移（2026-08-17）：migrateResources 纯函数单测（node:test，无依赖）。
// 语义：role-* permission.resources 从「原始 key + 11 个退役死 key」改写为
//   「保留具名能力的通俗名 + 通配 key（view-board:* / view-kpi:*）+ 退役 key 删除」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateResources } from '../migrate-perms-friendly.mjs';

test('具名 key → 通俗名；通配保留原样；未知名兜底保留原 key', () => {
  const out = migrateResources([
    'data-analysis:view:reports',   // → 经营总览
    'data-analysis:view:reports-targets', // → 目标达成
    'data-analysis:field:cost',     // → 成本可见
    'data-analysis:view-board:*',   // 通配保留
    'data-analysis:view-kpi:*',     // 通配保留
    'data-analysis:view:ghost',     // 未知名兜底保留原 key
  ]);
  assert.deepEqual(out, [
    '经营总览', '目标达成', '成本可见',
    'data-analysis:view-board:*', 'data-analysis:view-kpi:*', 'data-analysis:view:ghost',
  ]);
});

test('退役 11 个 key 从 resources 删除（含 8 个 report_*_gen + mobile + reports-items + wholesale-customers）', () => {
  const out = migrateResources([
    'data-analysis:view:mobile',
    'data-analysis:view:report_brand_metric_gen',
    'data-analysis:view:report_category_summary_gen',
    'data-analysis:view:report_item_breakdown_gen',
    'data-analysis:view:report_region_breakdown_gen',
    'data-analysis:view:report_supply_chain_outbound_gen',
    'data-analysis:view:report_wholesale_customer_gen',
    'data-analysis:view:report_wholesale_daily_customer_gen',
    'data-analysis:view:report_wholesale_daily_gen',
    'data-analysis:view:reports-items',
    'data-analysis:view:wholesale-customers',
    'data-analysis:view:reports',
  ]);
  assert.deepEqual(out, ['经营总览']); // 只剩具名通俗名
});

test('去重：通俗名已存在时不再重复 push', () => {
  const out = migrateResources(['data-analysis:view:reports', '经营总览']); // 原文已含通俗名
  assert.deepEqual(out, ['经营总览']);
});

test('全局通配 * 保留原样', () => {
  const out = migrateResources(['*', 'data-analysis:view:reports']);
  assert.deepEqual(out, ['*', '经营总览']);
});
