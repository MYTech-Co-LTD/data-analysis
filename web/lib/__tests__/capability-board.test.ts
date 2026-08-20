// web/lib/__tests__/capability-board.test.ts
// 方案 C（2026-08-17）：看板覆盖报表视图声明 + 覆盖唯一性
import { describe, it, expect } from 'vitest';
import { BOARD_CAPABILITIES, BOARD_VIEW_COVERAGE, KPI_CARD_CAPABILITIES } from '../capability-board';

describe('capability-board 覆盖视图声明（方案 C 统一视图/看板）', () => {
  it('每个带底层报表的看板声明覆盖视图（覆盖视图 ∈ 退役清单对应）', () => {
    const coverage = BOARD_VIEW_COVERAGE;
    expect(coverage.get('brand')).toEqual(['report_brand_metric_gen']);
    expect(coverage.get('category')).toEqual(['report_category_summary_gen']);
    expect(coverage.get('item-top-sale')).toEqual(['report_item_breakdown_gen']);
    expect(coverage.get('item-top-outbound')).toEqual(['report_item_breakdown_gen']);
    expect(coverage.get('region')).toEqual(['report_region_breakdown_gen']);
    expect(coverage.get('supply-chain')).toEqual(['report_supply_chain_outbound_gen']);
    expect(coverage.get('wholesale')).toEqual([
      'report_wholesale_customer_gen', 'report_wholesale_daily_customer_gen', 'report_wholesale_daily_gen',
    ]);
  });

  it('覆盖视图不重复（一个 view 只被一个看板覆盖；item-top 拆分例外白名单）', () => {
    const MULTI = new Set(['report_item_breakdown_gen']);   // 2026-08-19 商品TOP 拆销售/出库，双看板共视图有意为之
    const seen = new Set<string>();
    for (const views of BOARD_VIEW_COVERAGE.values()) {
      for (const v of views) {
        if (seen.has(v) && MULTI.has(v)) continue;
        expect(seen.has(v), `view 被多看板覆盖: ${v}`).toBe(false);
        seen.add(v);
      }
    }
  });

  it('kpi 看板无覆盖报表视图（纯指标卡层）', () => {
    expect(BOARD_VIEW_COVERAGE.has('kpi')).toBe(false);
  });

  it('看板能力总数与覆盖数一致（除 kpi）', () => {
    const boards = BOARD_CAPABILITIES;
    const withView = boards.filter((b) => b.view && b.view.length > 0);
    expect(withView.length).toBe(boards.length - 1); // 7 个带覆盖（item-top 拆双），kpi 无
    expect(KPI_CARD_CAPABILITIES.length).toBe(6);
  });
});
