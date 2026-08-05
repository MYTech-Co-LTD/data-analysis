import { describe, it, expect, vi } from 'vitest';
import { runC1 } from '../c1';
import type { DetailSource } from '../types';

const src = {
  name: 'retail',
  report_type: 'daily_sales',
  glob: 's3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet',
  agg_table: 'report_daily_sales',
  agg_metric: [
    { detail: 'sale_money', agg: 'total_sale' },
    { detail: 'profit', agg: 'total_profit' },
  ],
  brand_expr: "regexp_extract(filename,'retail_detail/([0-9]+)/',1)",
  detail_date_expr: "replace(order_detail_bizday,'-','')",
  tolerance: 0.01,
} as DetailSource;

describe('runC1', () => {
  it('passes when detail==agg per sbc|bizday|metric', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 100 }]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
    expect(r.detail).toBeNull();
    expect(r.check_type).toBe('C1');
    expect(r.check_name).toBe('retail');
  });

  it('fails with diff detail when mismatch', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 99 }]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].diff).toBe(1);
    expect((r.detail as any[])[0].metric).toBe('total_sale');
    expect((r.detail as any[])[0].sbc).toBe('3120');
  });

  it('pg 缺行视为 agg_sum=0 -> fail（明细未聚合）', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 50 }]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].agg_sum).toBe(0);
    expect((r.detail as any[])[0].diff).toBe(50);
  });

  it('M20: duck 缺行（pg-only key）-> 反向报 mismatch（聚合多算/明细漏算）', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '64188', bizday: '20260804', agg_sum: 70 }]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].sbc).toBe('64188');
    expect((r.detail as any[])[0].detail_sum).toBe(0);
    expect((r.detail as any[])[0].agg_sum).toBe(70);
    expect((r.detail as any[])[0].diff).toBe(-70);
  });

  it('M20: duck/pg 各有不同 key -> 双向均报 mismatch', async () => {
    // 单指标 src 便于断言数量
    const singleSrc = { ...src, agg_metric: [{ detail: 'sale_money', agg: 'total_sale' }] } as DetailSource;
    // duck 有 3120，pg 有 3120(mismatch) + 64188(duck 无)
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([
      { sbc: '3120', bizday: '20260804', agg_sum: 90 },   // duck 有，diff=10
      { sbc: '64188', bizday: '20260804', agg_sum: 50 },  // duck 无，反向 diff=-50
    ]) };
    const r = await runC1(singleSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    const details = r.detail as any[];
    expect(details).toHaveLength(2);
    // forward: 3120 diff=10
    expect(details.some((d: any) => d.sbc === '3120' && d.diff === 10)).toBe(true);
    // reverse: 64188 diff=-50
    expect(details.some((d: any) => d.sbc === '64188' && d.diff === -50)).toBe(true);
  });

  it('tolerance 内不报 mismatch（|diff|<=tolerance）', async () => {
    const tightSrc = { ...src, tolerance: 1 };
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 99.5 }]) };
    const r = await runC1(tightSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
  });

  it('多指标：一指标 pass 一指标 fail -> fail', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 100 }]) };
    // 第二个 agg_metric 调用返回不匹配
    pg.query
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 100 }]) // total_sale pass
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 80 }]);  // total_profit fail
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].metric).toBe('total_profit');
    expect((r.detail as any[])[0].diff).toBe(20);
  });
});
