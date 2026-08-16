// scripts/tests/scan-capabilities.test.mjs
// W1 Task2：scan 自动发现脚本单测（node:test，无依赖）。
// 双断言：新增（发现新视图/路由 → generated 多出该 key）/ 删除（源下线 → key 消失 + drift exit 1）。
// H14：删除的正道 = 人工 DEPRECATED 清单（renderGenerated 过滤）；catalog 已引用 key（保护键）不静默丢失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSources, renderGenerated, parseGenerated,
  planNext, invalidKeys, protectedViewKeys, deprecatedKeysFromCatalog,
} from '../scan-capabilities.mjs';

test('view-configs 的每个视图 → data-analysis:view:<name>', () => {
  const out = scanSources({ viewNames: ['reports', 'reports-items'] });
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports'));
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports-items'));
});

test('app 路由目录 → view:<route>（admin 路由除外——admin 走门禁不入 catalog）', () => {
  const out = scanSources({ routeDirs: ['reports', 'targets', 'branches'] });
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports'));
  assert.ok(out.every((e) => !e.key.startsWith('data-analysis:view:admin')));
});

test('删除方向不自动减（H14）：扫描结果不含已下线视图时，已标 deprecated 的 key 保留在输出外、不在 generated', () => {
  const out = scanSources({ viewNames: ['reports'] }); // 假设 reports-items 已下线
  assert.ok(!out.some((e) => e.key === 'data-analysis:view:reports-items'));
  // generated 中该 key 的移除只能由人工把它加入 DEPRECATED 后的下一轮 scan 或人工编辑完成——
  // 即 scan 永不产出「删除」，删除断言见 renderGenerated 对 DEPRECATED 的过滤
});

test('renderGenerated 输出可被 TS import（语法快照）', () => {
  const src = renderGenerated([{ key: 'data-analysis:view:x', label: 'x' }]);
  assert.ok(src.includes('GENERATED_CATALOG'));
  assert.ok(src.includes("data-analysis:view:x"));
});

// ---- 双断言核心（planNext：discovery ∪ 保护键 − deprecated）----

test('新增断言：源新增视图/路由 → planNext.next 多出该 key（--write 后 generated 多出；check 模式 added 报 drift）', () => {
  const current = parseGenerated(renderGenerated([{ key: 'data-analysis:view:reports' }]));
  const { next, added } = planNext({
    discovered: scanSources({ viewNames: ['reports', 'reports-new'], routeDirs: [] }),
    current,
  });
  assert.ok(next.some((e) => e.key === 'data-analysis:view:reports-new'));
  assert.deepEqual(added, ['data-analysis:view:reports-new']);
});

test('删除断言：源下线的非保护 key → next 不含且 removed 报出（check 模式 exit 1 drift）', () => {
  const current = parseGenerated(renderGenerated([
    { key: 'data-analysis:view:reports' },
    { key: 'data-analysis:view:report_old_gen' }, // 已在 generated、源已下线、非保护键
  ]));
  const { next, removed } = planNext({
    discovered: scanSources({ viewNames: ['reports'] }), // report_old_gen 不再被发现
    current,
  });
  assert.ok(!next.some((e) => e.key === 'data-analysis:view:report_old_gen'));
  assert.deepEqual(removed, ['data-analysis:view:report_old_gen']);
});

test('保护键保留：catalog（OVERRIDES/VIEW_GROUPS）引用的 key 源不可发现也不静默丢失——Task1「VIEW_GROUPS 成员 ∈ CATALOG」前置', () => {
  const current = parseGenerated(renderGenerated([
    { key: 'data-analysis:view:reports-items' }, // 种子 key：无对应源，但 catalog.ts 在引用
  ]));
  const { next, removed } = planNext({
    discovered: scanSources({ viewNames: ['reports'] }),
    current,
    protectedKeys: new Set(['data-analysis:view:reports-items']),
  });
  assert.ok(next.some((e) => e.key === 'data-analysis:view:reports-items'));
  assert.deepEqual(removed, []);
});

test('deprecated 过滤（H14 删除正道）：入废弃清单的 key 从 generated 移除', () => {
  const current = parseGenerated(renderGenerated([{ key: 'data-analysis:view:gone' }]));
  const { next } = planNext({
    discovered: scanSources({ viewNames: ['gone'] }),
    current,
    deprecated: new Set(['data-analysis:view:gone']),
  });
  assert.ok(!next.some((e) => e.key === 'data-analysis:view:gone'));
  // renderGenerated 对 DEPRECATED 的过滤（双保险，plan Task2 测试3 注释所指）
  assert.ok(!renderGenerated([{ key: 'data-analysis:view:gone' }], new Set(['data-analysis:view:gone']))
    .includes('data-analysis:view:gone'));
});

// ---- 命名空间守卫 + 解析往返 + catalog 只读抽取 ----

test('命名空间守卫：非法 slug → invalidKeys 非空（CLI 对应 exit 1）', () => {
  const bad = scanSources({ viewNames: ['ok-view', 'bad view!'] });
  assert.deepEqual(invalidKeys(bad), ['data-analysis:view:bad view!']);
});

test('parseGenerated ↔ renderGenerated 往返一致（canonical 化）', () => {
  const entries = scanSources({ viewNames: ['b-view', 'a_view'] });
  assert.deepEqual(parseGenerated(renderGenerated(entries)), entries);
});

test('protectedViewKeys / deprecatedKeysFromCatalog：从 catalog.ts 源码只读抽取（不改 catalog 文件）', () => {
  const catalogSrc = `
const OVERRIDES = { 'data-analysis:view:reports': { label: 'x' } };
export const VIEW_GROUPS = { 'data-analysis:view-group:g': { members: ['data-analysis:view:reports'] } } as const;
const DEPRECATED: readonly string[] = ['data-analysis:view:gone'];
`;
  assert.deepEqual([...protectedViewKeys(catalogSrc)].sort(), ['data-analysis:view:reports']);
  assert.deepEqual([...deprecatedKeysFromCatalog(catalogSrc)], ['data-analysis:view:gone']);
});
