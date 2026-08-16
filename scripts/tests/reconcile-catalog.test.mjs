// scripts/tests/reconcile-catalog.test.mjs
// W1 Task5（W1 退出判据）：permission.resources vs catalog 对账单测（node:test，无依赖）。
// 对账基准 = Casdoor Permission.resources（真授权语义，F11——resource 注册表只是可勾选面）。
// 通配持有者审计（M2/redteam）：废弃 key 被命名空间通配覆盖时，按 key 直接审计显示不出 → holders 必须可见。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff } from '../reconcile-catalog.mjs';

const CATALOG = new Set(['data-analysis:view:reports', 'data-analysis:field:cost', 'data-analysis:admin']);
const DEPRECATED = new Set([]);

test('permission.resources 引用未注册 key → E 级（反向发现，校验器同源逻辑）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:reports', 'data-analysis:view:ghost'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  assert.equal(d.red.length, 1);
  assert.equal(d.red[0].kind, 'E-unknown-key');
  assert.equal(d.red[0].key, 'data-analysis:view:ghost');
});

test('catalog 内 key 未被任何 permission 引用 → M 级提示（不算红）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:reports'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  assert.equal(d.red.length, 0);
  assert.ok(d.minor.length >= 2); // field:cost / admin 未被引用
});

test('通配持有者出现在废弃审计的 holders 里（M2：按 key 审计显示不出）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p-wild', resources: ['data-analysis:view:*'] }],
    catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
  });
  const gone = d.red.find((r) => r.key === 'data-analysis:view:gone');
  assert.ok(gone, '废弃 key 引用 = 红');
  assert.deepEqual(gone.holders, ['p-wild(view:*)']);  // 通配持有者必须可见
});
