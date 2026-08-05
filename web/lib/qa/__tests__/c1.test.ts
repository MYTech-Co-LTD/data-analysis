import { describe, it, expect, vi } from 'vitest';
import { runC1 } from '../c1';
import type { DetailSource } from '../types';
import detailSources from '../config/detail-sources.json';

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

const itemSalesSrc = {
  name: 'item_sales',
  report_type: 'item_sales',
  function_slug: '',
  glob: 's3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet',
  glob_date_format: 'iso',
  natural_key: [],
  agg_table: 'report_daily_item_sales',
  agg_key: ['system_book_code', 'item_num', 'biz_date'],
  agg_metric: [
    { detail: 'sale_money', agg: 'sale_amount' },
    { detail: 'profit', agg: 'sale_profit' },
  ],
  brand_expr: "regexp_extract(filename,'retail_detail/([0-9]+)/',1)",
  detail_date_expr: "replace(order_detail_bizday,'-','')",
  tolerance: 0.01,
} as DetailSource;

const wholesaleCustomerSrc = {
  name: 'wholesale_customer',
  report_type: 'wholesale_customer',
  function_slug: '',
  glob: 's3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet',
  glob_date_format: 'compact',
  natural_key: [],
  agg_table: 'report_daily_wholesale_customer',
  agg_key: ['system_book_code', 'client_code', 'biz_date'],
  agg_metric: [
    { detail: 'wholesale_money', agg: 'wholesale_amount' },
    { detail: 'wholesale_profit', agg: 'wholesale_profit' },
  ],
  brand_expr: "regexp_extract(filename,'wholesale_detail/([0-9]+)/',1)",
  detail_date_expr: "substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2)",
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

  it('item_sales：detail(retail_detail) vs report_daily_item_sales 按 sbc|bizday pass', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 888 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 888 }]) };
    const r = await runC1(itemSalesSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
    expect(r.check_name).toBe('item_sales');
  });

  it('item_sales：duck SQL 引用 retail_detail glob + sale_money→sale_amount 映射 + order_detail_bizday 日期表达式', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    await runC1(itemSalesSrc, '2026-08-04', '2026-08-04', { duck, pg });
    const sql: string = (duck.query as any).mock.calls[0][0];
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet'");
    expect(sql).toContain('SUM(CAST(sale_money AS DECIMAL(18,2)))');
    expect(sql).toContain("regexp_extract(filename,'retail_detail/([0-9]+)/',1) AS sbc");
    expect(sql).toContain("replace(order_detail_bizday,'-','') AS bizday");
    // pg 端查 item 聚合表 + sale_amount
    const pgSql: string = (pg.query as any).mock.calls[0][0];
    expect(pgSql).toContain('FROM report_daily_item_sales');
    expect(pgSql).toContain('SUM(sale_amount)');
  });

  it('item_sales：明细未聚合（pg 缺行）-> fail', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', detail_sum: 500 }]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    const r = await runC1(itemSalesSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].metric).toBe('sale_amount');
    expect((r.detail as any[])[0].diff).toBe(500);
  });

  it('wholesale_customer：detail(wholesale_detail) vs report_daily_wholesale_customer 按 sbc|bizday pass', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '64188', bizday: '20260804', detail_sum: 409 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '64188', bizday: '20260804', agg_sum: 409 }]) };
    const r = await runC1(wholesaleCustomerSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
    expect(r.check_name).toBe('wholesale_customer');
  });

  it('wholesale_customer：duck SQL 引用 wholesale_detail glob + audit_time 日期表达式 + wholesale_money→wholesale_amount', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    await runC1(wholesaleCustomerSrc, '2026-08-04', '2026-08-04', { duck, pg });
    const sql: string = (duck.query as any).mock.calls[0][0];
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet'");
    expect(sql).toContain('SUM(CAST(wholesale_money AS DECIMAL(18,2)))');
    expect(sql).toContain("substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS bizday");
    const pgSql: string = (pg.query as any).mock.calls[0][0];
    expect(pgSql).toContain('FROM report_daily_wholesale_customer');
    expect(pgSql).toContain('SUM(wholesale_amount)');
  });

  it('wholesale_customer：聚合多算（pg-only key）-> 反向 fail', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', agg_sum: 70 }]) };
    const r = await runC1(wholesaleCustomerSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].detail_sum).toBe(0);
    expect((r.detail as any[])[0].diff).toBe(-70);
  });
});

// item_outbound：custom_duck_sql 多源合并明细 SQL 路径（transfer ∪ wholesale，64188 dim_branch 重映射）
const itemOutboundSrc = detailSources.find((s) => s.name === 'item_outbound')! as DetailSource;

describe('runC1 item_outbound custom_duck_sql', () => {
  it('custom_duck_sql 路径：delivery_amount/wholesale_amount 按 sbc|bizday 各自 pass', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', delivery_amount: 100, wholesale_amount: 50 }]) };
    const pg = { query: vi.fn()
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 100 }])  // delivery_amount
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 50 }]),   // wholesale_amount
    };
    const r = await runC1(itemOutboundSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
    expect(r.check_name).toBe('item_outbound');
    expect(r.detail).toBeNull();
    // 每指标各一次 duck + pg 查询（custom SQL 跑两遍，读各自 m.detail 列）
    expect(duck.query).toHaveBeenCalledTimes(2);
    expect(pg.query).toHaveBeenCalledTimes(2);
  });

  it('custom_duck_sql：日期占位替换 + 双源 glob + 64188 dim_branch 重映射，pg 查 item_outbound 聚合表', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    await runC1(itemOutboundSrc, '2026-08-01', '2026-08-04', { duck, pg });
    const sql: string = (duck.query as any).mock.calls[0][0];
    expect(sql).not.toContain('{{fromCompact}}');
    expect(sql).not.toContain('{{toCompact}}');
    expect(sql).toContain("BETWEEN '20260801' AND '20260804'");
    // 双源合并：transfer_detail（delivery）+ wholesale_detail（wholesale）
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/all.parquet'");
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/all.parquet'");
    // 64188 重映射：dim_branch by client_name
    expect(sql).toContain("db.system_book_code='64188'");
    expect(sql).toContain('db.branch_name=w.client_name');
    // FULL OUTER JOIN 合并两源
    expect(sql).toContain('FULL OUTER JOIN wholesale w');
    // pg 端查 item_outbound 聚合表 + delivery_amount
    const pgSql: string = (pg.query as any).mock.calls[0][0];
    expect(pgSql).toContain('FROM report_daily_item_outbound');
    expect(pgSql).toContain('SUM(delivery_amount)');
  });

  it('custom_duck_sql 多指标：delivery_amount pass 但 wholesale_amount fail -> fail（读各自 m.detail 列）', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', delivery_amount: 100, wholesale_amount: 50 }]) };
    const pg = { query: vi.fn()
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 100 }])  // delivery_amount pass
      .mockResolvedValueOnce([{ sbc: '3120', bizday: '20260804', agg_sum: 40 }]),   // wholesale_amount fail diff=10
    };
    const r = await runC1(itemOutboundSrc, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect((r.detail as any[])[0].metric).toBe('wholesale_amount');
    expect((r.detail as any[])[0].diff).toBe(10);
  });

  it('custom_duck_sql M20：pg-only key 反向报 mismatch（聚合多算/明细漏算）', async () => {
    const singleMetric = { ...itemOutboundSrc, agg_metric: [{ detail: 'delivery_amount', agg: 'delivery_amount' }] } as DetailSource;
    const duck = { query: vi.fn().mockResolvedValue([{ sbc: '3120', bizday: '20260804', delivery_amount: 100 }]) };
    const pg = { query: vi.fn().mockResolvedValue([{ sbc: '64188', bizday: '20260804', agg_sum: 70 }]) };
    const r = await runC1(singleMetric, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    const details = r.detail as any[];
    // forward: 3120 明细未聚合 diff=100；reverse: 64188 聚合多算 diff=-70
    expect(details.some((d: any) => d.sbc === '3120' && d.diff === 100)).toBe(true);
    expect(details.some((d: any) => d.sbc === '64188' && d.detail_sum === 0 && d.diff === -70)).toBe(true);
  });

  it('默认路径兼容：无 custom_duck_sql 源仍走默认单源 SQL（detail_sum 别名，现有源不受影响）', async () => {
    const duck = { query: vi.fn().mockResolvedValue([]) };
    const pg = { query: vi.fn().mockResolvedValue([]) };
    await runC1(itemSalesSrc, '2026-08-04', '2026-08-04', { duck, pg });
    const sql: string = (duck.query as any).mock.calls[0][0];
    expect(sql).toContain('AS detail_sum');
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet'");
    expect(sql).not.toContain('custom_duck_sql');
  });
});
