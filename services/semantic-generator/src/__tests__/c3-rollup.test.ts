import { describe, it, expect, vi } from 'vitest';
import { buildRollupPivotSql, runRollupChecks, C3_ROLLUP_VIEWS, C3_TOLERANCE } from '../index.js';

describe('C3 rollup 自洽 pivot（L4）', () => {
  it('C3_ROLLUP_VIEWS 覆盖 2 张层级视图 + 校验指标', () => {
    expect(C3_ROLLUP_VIEWS).toEqual([
      { view: 'report_region_breakdown_gen', metrics: ['sale_actual', 'delivery_actual'] },
      { view: 'report_supply_chain_outbound_gen', metrics: ['delivery_amount'] },
    ]);
  });

  it('buildRollupPivotSql 含 metric 替换 + 容差 HAVING（region/sub_region/store SUM）', () => {
    const sql = buildRollupPivotSql('report_region_breakdown_gen', 'sale_actual');
    expect(sql).toContain("FROM report_region_breakdown_gen");
    expect(sql).toContain("SUM(CASE WHEN level='region' THEN sale_actual END) AS region_total");
    expect(sql).toContain("SUM(CASE WHEN level='sub_region' THEN sale_actual END) AS sub_region_total");
    expect(sql).toContain("SUM(CASE WHEN level='store' THEN sale_actual END) AS store_total");
    expect(sql).toContain(`ABS(region_total - sub_region_total) > ${C3_TOLERANCE}`);
    expect(sql).toContain(`ABS(region_total - store_total) > ${C3_TOLERANCE}`);
  });

  it('pivot 有 mismatch 行 → 收集 rollupFailures（含 view/metric/target_id/region/sub/store）', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [
          { target_id: 7, region_total: 100, sub_region_total: 100, store_total: 99.5 },
        ] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const failures = await runRollupChecks(client as any, ['report_region_breakdown_gen', 'report_supply_chain_outbound_gen']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('report_region_breakdown_gen.sale_actual');
    expect(failures[0]).toContain('target_id=7');
    expect(failures[0]).toContain('region 100');
    expect(failures[0]).toContain('store 99.5');
  });

  it('pivot 无 mismatch → 空数组（视图空数据平凡通过）', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const failures = await runRollupChecks(client as any, ['report_region_breakdown_gen', 'report_supply_chain_outbound_gen']);
    expect(failures).toEqual([]);
  });

  it('本次未产出视图 → 跳过（不查询）', async () => {
    const client = { query: vi.fn() };
    const failures = await runRollupChecks(client as any, ['report_brand_metric_gen']);
    expect(failures).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('pivot 查询失败 → 记 error 到 rollupFailures', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('relation does not exist')),
    };
    const failures = await runRollupChecks(client as any, ['report_region_breakdown_gen']);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('C3 pivot 查询失败');
    expect(failures[0]).toContain('relation does not exist');
  });
});
