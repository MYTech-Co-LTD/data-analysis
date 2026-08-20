// web/lib/__tests__/capability-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { capabilityCatalog, CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS, KEY_TO_LABEL, LABEL_TO_KEY, KEY_TO_DISPLAY_NAME, DISPLAY_NAME_TO_KEY, DISPLAY_SEP, displayNameFor } from '../capability-catalog';

describe('capability-catalog 单真相', () => {
  it('catalog 非空且 key 全局唯一', () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    const keys = capabilityCatalog.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('全部 key 符合命名空间（data-analysis:view|view-board|view-kpi|view-group|field|brand|category|admin）', () => {
    const ns = /^data-analysis:(view|view-board|view-kpi|view-group|gate|field|brand|category|admin):?[A-Za-z0-9_一-龥-]*$/;
    for (const e of capabilityCatalog) expect(e.key, e.key).toMatch(ns);
  });
  it('DEPRECATED 与 CATALOG 不相交（废弃即不在册）', () => {
    for (const d of DEPRECATED_KEYS) expect(CATALOG_KEYS.has(d)).toBe(false);
  });
  it('VIEW_GROUPS 已清空（2026-08-18 方案 A：view-group 机制随 view:reports/目标达成删除）', () => {
    expect(Object.keys(VIEW_GROUPS)).toHaveLength(0);
  });
  it('种子含 admin 门禁与 cost 字段', () => {
    expect(CATALOG_KEYS.has('data-analysis:admin')).toBe(true);
    expect(CATALOG_KEYS.has('data-analysis:field:cost')).toBe(true);
  });
  it('看板/KPI 能力入册且带通俗命名+描述（单真相 capability-board.ts）', () => {
    // 7 个看板能力
    for (const id of ['kpi','brand','region','item-top-sale','item-top-outbound','category','supply-chain','wholesale']) {
      const key = `data-analysis:view-board:${id}`;
      expect(CATALOG_KEYS.has(key), `看板能力缺: ${key}`).toBe(true);
    }
    // 6 个 KPI 卡片能力
    for (const code of ['sale','delivery','outbound_amt','outbound_profit','delivery_sale_ratio','outbound_margin']) {
      const key = `data-analysis:view-kpi:${code}`;
      expect(CATALOG_KEYS.has(key), `KPI 能力缺: ${key}`).toBe(true);
    }
    // 带 label（通俗名）/description
    for (const e of capabilityCatalog) {
      if (e.key.startsWith('data-analysis:view-board:') || e.key.startsWith('data-analysis:view-kpi:')) {
        expect(e.label, `${e.key} 缺通俗名`).toBeTruthy();
        expect(e.description, `${e.key} 缺描述`).toBeTruthy();
      }
    }
  });

  // ===== 方案 C（2026-08-17）：统一视图/看板 + 全量通俗名 =====

  it('退役 11 个零消费 view:* 死 key（方案 C 统一视图/看板）', () => {
    const retired = [
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
    ];
    for (const k of retired) {
      expect(CATALOG_KEYS.has(k), `${k} 未退役`).toBe(false);
      expect(DEPRECATED_KEYS.has(k), `${k} 未进 DEPRECATED`).toBe(true);
    }
  });

  it('2026-08-18 方案 A：view:reports/view:reports-targets 已删，报表中心入口归 gate', () => {
    expect(CATALOG_KEYS.has('data-analysis:view:reports')).toBe(false);
    expect(CATALOG_KEYS.has('data-analysis:view:reports-targets')).toBe(false);
    expect(CATALOG_KEYS.has('data-analysis:gate:reports-center')).toBe(true);  // 门禁普通能力入册
    // 保留的具名能力（非通配）label 不得为英文 slug
    for (const e of capabilityCatalog) {
      if (e.key.startsWith('data-analysis:view:') && !e.key.endsWith(':*')) {
        expect(/[\u4e00-\u9fff]/.test(e.label), `${e.key} label 非中文通俗名: ${e.label}`).toBe(true);
      }
    }
  });

  it('VIEW_GROUPS 无残留成员（方案 A 全量清空：无 view-group 成员引用）', () => {
    const members = (Object.values(VIEW_GROUPS) as Array<{ members: string[] }>).flatMap((g) => g.members);
    expect(members).toEqual([]);
    expect(members).not.toContain('data-analysis:view:reports');
    expect(members).not.toContain('data-analysis:view:reports-targets');
  });

  it('通俗名全局唯一（Casdoor resource name 主键 + BY_NAME 反查）', () => {
    const names = capabilityCatalog.filter((e) => e.label).map((e) => e.label);
    expect(new Set(names).size).toBe(names.length);
  });

  it('KEY_TO_LABEL / LABEL_TO_KEY 双向映射一致（全量归一查找表）', () => {
    expect(KEY_TO_LABEL.get('data-analysis:brand:3120')).toBe('熊喵鲜生');
    expect(LABEL_TO_KEY.get('熊喵鲜生')).toBe('data-analysis:brand:3120');
    expect(LABEL_TO_KEY.get('品牌×指标')).toBe('data-analysis:view-board:brand'); // 看板通俗名入册
    expect(LABEL_TO_KEY.get('门店零售')).toBe('data-analysis:view-kpi:sale'); // KPI 通俗名入册
  });
});

describe('casdoor 展示名（组|label）', () => {
  it('分隔符为半角 |', () => {
    expect(DISPLAY_SEP).toBe('|');
  });
  it('KEY_TO_DISPLAY_NAME 全量覆盖 catalog（每个 key 都有展示名）', () => {
    for (const e of capabilityCatalog) {
      expect(KEY_TO_DISPLAY_NAME.has(e.key), `${e.key} 缺展示名`).toBe(true);
      expect(KEY_TO_DISPLAY_NAME.get(e.key)).toMatch(/^.+\|.+$/);
    }
  });
  it('有 label → 组|label；group 来自 merged 后的最终值', () => {
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:brand:3120')).toBe('品牌|熊喵鲜生');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:admin')).toBe('门禁|管理台');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:view-board:brand')).toBe('看板|品牌×指标');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:view-kpi:sale')).toBe('看板|门店零售');
  });
  it('DISPLAY_NAME_TO_KEY 双向一致（全量反查）', () => {
    expect(DISPLAY_NAME_TO_KEY.get('品牌|熊喵鲜生')).toBe('data-analysis:brand:3120');
    expect(DISPLAY_NAME_TO_KEY.get('看板|品牌×指标')).toBe('data-analysis:view-board:brand');
    expect(DISPLAY_NAME_TO_KEY.get('看板|门店零售')).toBe('data-analysis:view-kpi:sale');
  });
  it('展示名全局唯一（Casdoor resource.name 主键 + 反查不可歧义）', () => {
    const names = [...KEY_TO_DISPLAY_NAME.values()];
    expect(new Set(names).size).toBe(names.length);
  });
  it('displayNameFor 单 key 查询', () => {
    expect(displayNameFor('data-analysis:brand:3120')).toBe('品牌|熊喵鲜生');
  });
});
