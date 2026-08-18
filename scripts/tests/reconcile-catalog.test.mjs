// scripts/tests/reconcile-catalog.test.mjs
// W1 Task5（W1 退出判据）：permission.resources vs catalog 对账单测（node:test，无依赖）。
// 对账基准 = Casdoor Permission.resources（真授权语义，F11——resource 注册表只是可勾选面）。
// 通配持有者审计（M2/redteam）：废弃 key 被命名空间通配覆盖时，按 key 直接审计显示不出 → holders 必须可见。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff, FRIENDLY_TO_KEY } from '../reconcile-catalog.mjs';

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

// 方案甲/方案C：permission.resources 含通俗名（Casdoor 下拉选中写入）→ normKey 归一后不误报 E-unknown
test('通俗名在 permission.resources → 归一回 key，不误报 E-unknown / 不 M-unreferenced 漏报', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['看板|经营总览', '字段|成本可见'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  assert.equal(d.red.length, 0, '通俗名归一后命中 catalog → 无红');
  const referencedKeys = d.perUser.find((u) => u.user === 'p1').keys;
  assert.ok(referencedKeys.includes('data-analysis:view:reports'), '通俗名「经营总览」归一 → catalog key 进 keys');
  assert.ok(referencedKeys.includes('data-analysis:field:cost'), '通俗名「成本可见」归一 → catalog key 进 keys');
});

// 方案C：退役 key 仍被授权语义覆盖 → E-deprecated-key 红
test('退役 key（如 view:mobile）仍被 permission 引用 → E-deprecated-key 红', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:mobile'] }],
    catalog: CATALOG, deprecated: new Set(['data-analysis:view:mobile']),
  });
  const gone = d.red.find((r) => r.key === 'data-analysis:view:mobile');
  assert.ok(gone, '退役 key 被引用 = 红');
  assert.equal(gone.kind, 'E-deprecated-key');
});

// 静态镜像数量钉死（防与 catalog/claims 漂移）：23 条 = 10 catalog + 7 看板 + 6 KPI
test('通俗名静态镜像恰 23 条（与 catalog/claims 同步防漂移）', () => {
  assert.equal(Object.keys(FRIENDLY_TO_KEY).length, 23);
});

// 2026-08-18：全局 '*' 持有单独成红（Casdoor 空配置默认 ['*'] 风险），不再连锁展开废弃覆盖（web 侧同基线）
test('全局 * 持有 → E-global-wildcard 独立红，废弃 key 无连锁误报', () => {
  const d = classifyDiff({
    permissions: [
      { name: '测试', resources: ['*'] },
      { name: 'p-ok', resources: ['data-analysis:view:reports'] },
    ],
    catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
  });
  assert.equal(d.red.length, 1, '只有一条红：* 独立成条');
  assert.deepEqual(d.red[0], { kind: 'E-global-wildcard', key: '*', holders: ['测试'] });
  assert.deepEqual(d.wildcardHolders, [{ user: '测试', wildcard: '*' }]);
});
