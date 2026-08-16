// web/lib/__tests__/capability-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { capabilityCatalog, CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS } from '../capability-catalog';

describe('capability-catalog 单真相', () => {
  it('catalog 非空且 key 全局唯一', () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    const keys = capabilityCatalog.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('全部 key 符合命名空间（data-analysis:view|view-group|field|brand|category|admin）', () => {
    const ns = /^data-analysis:(view|view-group|field|brand|category|admin):?[A-Za-z0-9_一-龥-]*$/;
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
});
