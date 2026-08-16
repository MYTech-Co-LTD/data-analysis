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

  it('废弃 key：直接引用 ∪ 命名空间通配 ∪ 全局 * 三源合并 holders（M2 通配审计）', () => {
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
    // holder 展示短格式 view:*（与 scripts 侧 shortWild 基线一致）
    expect([...(gone?.holders ?? [])].sort()).toEqual(['p-all(*)', 'p-direct', 'p-wild(view:*)']);
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
});
