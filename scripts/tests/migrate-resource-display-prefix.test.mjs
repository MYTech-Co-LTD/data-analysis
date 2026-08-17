// scripts/tests/migrate-resource-display-prefix.test.mjs
// 2026-08-17 迁移：Casdoor resource.name 加「组|」前缀。纯函数单测（node:test，无依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResourceNameMap, migrateResources } from '../migrate-resource-display-prefix.mjs';

test('buildResourceNameMap：全量 key → 组|label（23 条 catalog 具名 + 看板/KPI）', () => {
  const m = buildResourceNameMap();
  assert.equal(m.get('data-analysis:view:reports'), '看板|经营总览');
  assert.equal(m.get('data-analysis:brand:3120'), '品牌|熊喵鲜生');
  assert.equal(m.get('data-analysis:field:cost'), '字段|成本可见');
  assert.equal(m.get('data-analysis:admin'), '门禁|管理台');
  assert.equal(m.get('data-analysis:view-board:brand'), '看板|品牌×指标');
  assert.equal(m.get('data-analysis:view-kpi:sale'), '看板|门店零售');
  assert.ok(m.size >= 23, `至少 23 条：${m.size}`);
});

test('migrateResources：permission.resources 旧展示名/裸 key → 组|label；通配原样保留', () => {
  const m = buildResourceNameMap();
  const out = migrateResources(m, [
    '经营总览',            // 旧通俗名（迁移前已存在的 permission 值）
    'data-analysis:view:reports', // 裸 key（与上一条同映射 → 去重）
    'data-analysis:view-board:*', // 通配保留
    'data-analysis:view-kpi:*',   // 通配保留
    'push:broadcast',      // 引擎裸 key 原样
    '未知串',              // 未知名兜底保留原样
  ]);
  assert.deepEqual(out, [
    '看板|经营总览',        // 两条输入同映射，去重剩 1 个
    'data-analysis:view-board:*',
    'data-analysis:view-kpi:*',
    'push:broadcast',
    '未知串',
  ]);
});
