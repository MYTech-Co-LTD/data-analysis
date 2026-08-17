// web/lib/__tests__/capability-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { capabilityCatalog, CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS } from '../capability-catalog';

describe('capability-catalog 单真相', () => {
  it('catalog 非空且 key 全局唯一', () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    const keys = capabilityCatalog.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('全部 key 符合命名空间（data-analysis:view|view-board|view-kpi|view-group|field|brand|category|admin）', () => {
    const ns = /^data-analysis:(view|view-board|view-kpi|view-group|field|brand|category|admin):?[A-Za-z0-9_一-龥-]*$/;
    for (const e of capabilityCatalog) expect(e.key, e.key).toMatch(ns);
  });
  it('DEPRECATED 与 CATALOG 不相交（废弃即不在册）', () => {
    for (const d of DEPRECATED_KEYS) expect(CATALOG_KEYS.has(d)).toBe(false);
  });
  it('VIEW_GROUPS 成员必须 ∈ CATALOG 且禁含通配', () => {
    for (const [g, def] of Object.entries(VIEW_GROUPS)) {
      expect(CATALOG_KEYS.has(g)).toBe(true); // 组名自身也是 resource
      for (const m of def.members) {
        expect(m.includes('*'), `${g} 成员禁通配: ${m}`).toBe(false);
        expect(CATALOG_KEYS.has(m), `${g} 成员不在册: ${m}`).toBe(true);
      }
    }
  });
  it('种子含 admin 门禁与 cost 字段', () => {
    expect(CATALOG_KEYS.has('data-analysis:admin')).toBe(true);
    expect(CATALOG_KEYS.has('data-analysis:field:cost')).toBe(true);
  });
  it('看板/KPI 能力入册且带通俗命名+描述（单真相 capability-board.ts）', () => {
    // 7 个看板能力
    for (const id of ['kpi','brand','region','item-top','category','supply-chain','wholesale']) {
      const key = `data-analysis:view-board:${id}`;
      expect(CATALOG_KEYS.has(key), `看板能力缺: ${key}`).toBe(true);
    }
    // 6 个 KPI 卡片能力
    for (const code of ['sale','delivery','outbound_amt','outbound_profit','delivery_sale_ratio','outbound_margin']) {
      const key = `data-analysis:view-kpi:${code}`;
      expect(CATALOG_KEYS.has(key), `KPI 能力缺: ${key}`).toBe(true);
    }
    // 带 name/description
    for (const e of capabilityCatalog) {
      if (e.key.startsWith('data-analysis:view-board:') || e.key.startsWith('data-analysis:view-kpi:')) {
        expect(e.name, `${e.key} 缺通俗命名`).toBeTruthy();
        expect(e.description, `${e.key} 缺描述`).toBeTruthy();
      }
    }
  });
});
