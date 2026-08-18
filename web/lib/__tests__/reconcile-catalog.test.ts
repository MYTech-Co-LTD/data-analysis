// web/lib/__tests__/reconcile-catalog.test.ts
// W1 Task6：catalog 对账核心（web 侧）——辅助页 /api/admin/capabilities 与 cron job 共用。
// 语义基线 = scripts/tests/reconcile-catalog.test.mjs（Task 5 CLI 门禁版）同源对齐：
// E-unknown / E-deprecated（红，holders 三源合并）/ C-sync-failed（红，L2 不静默）/
// M-unreferenced（提示）/ wildcardHolders 单列（含 push:* 引擎裸 key，M2 风险面）。
import { describe, it, expect } from 'vitest';
import { classifyCatalogReconcile } from '../reconcile-catalog';
import { CATALOG_KEYS } from '../capability-catalog';

const CATALOG = new Set(['data-analysis:view:reports', 'data-analysis:field:cost', 'data-analysis:admin']);
const DEPRECATED = new Set<string>([]);

describe('catalog 对账核心（Task 5 语义同源，catalog 集参数化注入）', () => {
  it('permission 引用未知 key → E-unknown-key 红（反向发现）', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['data-analysis:view:reports', 'data-analysis:view:ghost'] }],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(1);
    expect(d.red[0].kind).toBe('E-unknown-key');
    expect(d.red[0].key).toBe('data-analysis:view:ghost');
    expect(d.red[0].holders).toEqual(['p1']);
  });

  it('catalog 内 key 未被引用 → M-unreferenced 提示（不算红）', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['data-analysis:view:reports'] }],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(0);
    expect(d.minor.map((m) => m.key).sort()).toEqual(
      ['data-analysis:admin', 'data-analysis:field:cost'],
    );
  });

  it('废弃 key：直接引用 ∪ 命名空间通配合并 holders（M2 通配审计；全局 * 已单列不再计入）', () => {
    const d = classifyCatalogReconcile({
      permissions: [
        { name: 'p-direct', resources: ['data-analysis:view:gone'] },
        { name: 'p-wild', resources: ['data-analysis:view:*'] },
        { name: 'p-all', resources: ['*'] },
      ],
      catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
    });
    const gone = d.red.find((r) => r.key === 'data-analysis:view:gone');
    expect(gone?.kind).toBe('E-deprecated-key');
    // holder 展示短格式 view:*（与 scripts 侧 shortWild 基线一致）；p-all 不再连锁计入
    expect([...(gone?.holders ?? [])].sort()).toEqual(['p-direct', 'p-wild(view:*)']);
  });

  it('全局 * 持有 → E-global-wildcard 独立红（Casdoor 空配置默认 * 风险；2026-08-18）', () => {
    const d = classifyCatalogReconcile({
      permissions: [
        { name: '测试', resources: ['*'] },
        { name: 'p-ok', resources: ['data-analysis:view:reports'] },
      ],
      catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
    });
    // 只有一条红：* 独立成条；废弃 key gone 无持有者不算红（无连锁误报）
    expect(d.red.length).toBe(1);
    expect(d.red[0]).toEqual({ kind: 'E-global-wildcard', key: '*', holders: ['测试'] });
    // wildcardHolders 仍单列风险面
    expect(d.wildcardHolders).toEqual([{ user: '测试', wildcard: '*' }]);
  });

  it('废弃 key 无任何持有者 → 不算红（驱逐判据之一：红区清零）', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['data-analysis:view:reports'] }],
      catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
    });
    expect(d.red.length).toBe(0);
  });

  it('resource-sync 失败喂入 → C-sync-failed 红（能力注册失败 = 永不可配，L2）', () => {
    const d = classifyCatalogReconcile({
      permissions: [],
      catalog: CATALOG, deprecated: DEPRECATED,
      syncFailures: [{ key: 'data-analysis:category:水果', error: 'charset?' }],
    });
    expect(d.red.length).toBe(1);
    expect(d.red[0]).toMatchObject({ kind: 'C-sync-failed', key: 'data-analysis:category:水果' });
    expect(d.red[0].holders).toEqual(['resource-sync']);
  });

  it('通配持有者单列（含 push:* 引擎裸 key）；通配与 push:* 不入红', () => {
    const d = classifyCatalogReconcile({
      permissions: [
        { name: 'p-wild', resources: ['data-analysis:view:*'] },
        { name: 'p-push', resources: ['push:broadcast'] },
      ],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(0);
    expect(d.wildcardHolders).toEqual([{ user: 'p-wild', wildcard: 'data-analysis:view:*' }]);
  });

  it('真实 catalog 缺省参数：空 permissions → 全量 M-unreferenced、零红', () => {
    const d = classifyCatalogReconcile({ permissions: [] });
    expect(d.red.length).toBe(0);
    expect(d.minor.length).toBe(CATALOG_KEYS.size);
  });

  it('get-resources 怪癖防御：resources 名带 "/" 前缀不漏判（H3）', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['/data-analysis:view:reports'] }],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(0);   // "/data-analysis:view:reports" 归一后命中 catalog，不算未知
    expect(d.minor.length).toBe(2); // field:cost / admin 未引用
  });

  it('方案C：permission.resources 含组|label（Casdoor 下拉选中）→ 归一回 key 不误报 E-unknown', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['看板|经营总览', '字段|成本可见'] }],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(0);   // 「看板|经营总览」→ view:reports、「字段|成本可见」→ field:cost 均命中
    const minorKeys = d.minor.map((m) => m.key);
    expect(minorKeys).not.toContain('data-analysis:view:reports');
    expect(minorKeys).not.toContain('data-analysis:field:cost');
    expect(minorKeys).toContain('data-analysis:admin');   // 只有 admin 未引用
  });

  it('方案C：退役 key 仍被 permission 引用 → E-deprecated-key 红', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['data-analysis:view:mobile'] }],
      catalog: CATALOG, deprecated: new Set(['data-analysis:view:mobile']),
    });
    const gone = d.red.find((r) => r.key === 'data-analysis:view:mobile');
    expect(gone).toBeDefined();
    expect(gone!.kind).toBe('E-deprecated-key');
  });
});
