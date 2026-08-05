// web/lib/qa/__tests__/c3-runner.test.ts
// C3 runner 单测：mock db.rpc(execute_sql) 返 pivot 行，验证 mismatch 判定 / 定向过滤 / 错误兜底。
import { describe, it, expect, vi } from 'vitest';
import { runC3Checks, buildRollupPivotSql, C3_ROLLUP_VIEWS, C3_TOLERANCE } from '../c3-runner';

function makeDb(rpcImpl?: (...args: any[]) => Promise<any>) {
  const db: any = {
    rpc: vi.fn(rpcImpl ?? (async () => ({ data: [] }))),
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: null }),
    }),
  };
  return db;
}

describe('buildRollupPivotSql', () => {
  it('builds pivot with region/sub_region/store CASE sums', () => {
    const sql = buildRollupPivotSql('report_region_breakdown_gen', 'sale_actual', true);
    expect(sql).toContain("SUM(CASE WHEN level='region' THEN sale_actual END) AS region_total");
    expect(sql).toContain("SUM(CASE WHEN level='sub_region' THEN sale_actual END) AS sub_region_total");
    expect(sql).toContain("SUM(CASE WHEN level='store' THEN sale_actual END) AS store_total");
    expect(sql).toContain('GROUP BY target_id');
  });

  it('onlyMismatches=true adds HAVING tolerance filter', () => {
    const sql = buildRollupPivotSql('v', 'm', true);
    expect(sql).toContain('HAVING ABS(region_total - sub_region_total) > 0.01 OR ABS(region_total - store_total) > 0.01');
  });

  it('onlyMismatches=false omits HAVING (health panel wants all rows)', () => {
    const sql = buildRollupPivotSql('report_supply_chain_outbound_gen', 'delivery_amount', false);
    expect(sql).not.toContain('HAVING');
  });
});

describe('runC3Checks', () => {
  it('pass when pivot returns no mismatch rows, writes qa_logs per view', async () => {
    const db = makeDb();
    const results = await runC3Checks({ db, runId: 'r1', trigger: 'cron' });
    expect(results).toHaveLength(C3_ROLLUP_VIEWS.length);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results.every((r) => r.diff === 0)).toBe(true);
    expect(db.from).toHaveBeenCalledWith('qa_logs');
    expect(db.from().insert).toHaveBeenCalledTimes(C3_ROLLUP_VIEWS.length);
  });

  it('fail when pivot returns mismatch rows (unwraps to_jsonb)', async () => {
    const db = makeDb(async () => ({
      data: [{ to_jsonb: { target_id: 1, region_total: 100, sub_region_total: 90, store_total: 100 } }],
    }));
    const results = await runC3Checks({ db, runId: 'r2', trigger: 'manual' });
    const region = results.find((r) => r.check_name === 'report_region_breakdown_gen')!;
    expect(region.status).toBe('fail');
    expect(region.diff).toBe(10);
    expect((region.detail as any[])[0]).toMatchObject({
      view: 'report_region_breakdown_gen',
      metric: 'sale_actual',
      target_id: 1,
      region_total: 100,
      sub_region_total: 90,
      store_total: 100,
      region_vs_sub_region_diff: 10,
      region_vs_store_diff: 0,
    });
  });

  it('handles bare object rows (PostgREST unwrapped shape) and null totals', async () => {
    const db = makeDb(async () => ({
      data: [{ target_id: 2, region_total: null, sub_region_total: 5, store_total: 5 }],
    }));
    const results = await runC3Checks({ db, runId: 'r2b', trigger: 'cron' });
    const region = results.find((r) => r.check_name === 'report_region_breakdown_gen')!;
    expect(region.status).toBe('fail');
    // null region 视为 0 → |0-5|=5
    expect((region.detail as any[])[0]).toMatchObject({ target_id: 2, region_vs_sub_region_diff: 5 });
  });

  it('error when execute_sql rpc errors', async () => {
    const db = makeDb(async () => ({ error: { message: 'relation does not exist' } }));
    const results = await runC3Checks({ db, runId: 'r3', trigger: 'cron' });
    expect(results).toHaveLength(C3_ROLLUP_VIEWS.length);
    expect(results.every((r) => r.status === 'error')).toBe(true);
    expect((results[0].detail as any[])[0].error).toContain('relation does not exist');
  });

  it('checks filter: C3:<view> only checks that view', async () => {
    const db = makeDb();
    const results = await runC3Checks({ db, runId: 'r4', trigger: 'manual', checks: ['C3:report_region_breakdown_gen'] });
    expect(results).toHaveLength(1);
    expect(results[0].check_name).toBe('report_region_breakdown_gen');
    // rpc 只被调一次（该视图 2 个 metric）
    expect(db.rpc).toHaveBeenCalledTimes(2);
  });

  it('checks filter: bare C3 checks all views', async () => {
    const db = makeDb();
    const results = await runC3Checks({ db, runId: 'r5', trigger: 'manual', checks: ['C3'] });
    expect(results).toHaveLength(C3_ROLLUP_VIEWS.length);
  });

  it('checks filter: unrelated key skips C3 entirely', async () => {
    const db = makeDb();
    const results = await runC3Checks({ db, runId: 'r6', trigger: 'manual', checks: ['D2:retail'] });
    expect(results).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('exported C3_TOLERANCE matches SQL constant', () => {
    expect(C3_TOLERANCE).toBe(0.01);
    expect(buildRollupPivotSql('v', 'm', true)).toContain(String(C3_TOLERANCE));
  });
});
