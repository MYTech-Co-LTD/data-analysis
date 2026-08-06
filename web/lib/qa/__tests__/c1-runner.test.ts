// web/lib/qa/__tests__/c1-runner.test.ts
// C1 runner 单测：mock runC1 + /compute(fetch)，验证 retry ≤3 + 收敛 + 仍 fail 放弃。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock runC1（不测对账核心本身，只测 runner 编排 + retry 逻辑）
vi.mock('../c1', () => ({
  runC1: vi.fn(),
}));

import { runC1 } from '../c1';
import { runC1Checks } from '../c1-runner';
import type { CheckResult, QaTrigger } from '../types';

const PASS = (name: string): CheckResult => ({
  run_id: '', trigger: 'manual', check_type: 'C1', check_name: name,
  status: 'pass', diff: 0, detail: null,
});

const FAIL = (name: string, bizday = '20260804'): CheckResult => ({
  run_id: '', trigger: 'manual', check_type: 'C1', check_name: name,
  status: 'fail', diff: 10,
  detail: [{ sbc: '3120', bizday, metric: 'total_sale', detail_sum: 100, agg_sum: 90, diff: 10 }],
});

function makeDb() {
  return {
    rpc: vi.fn().mockResolvedValue({ data: [] }),
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: null }),
    }),
  };
}

function makeDuck() {
  return vi.fn().mockResolvedValue([]);
}

describe('runC1Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch for /compute calls
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pass on first try: no /compute called, no retry', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-1',
      trigger: 'manual',
    });

    expect(results).toHaveLength(6); // retail, delivery, wholesale, item_sales, wholesale_customer, item_outbound
    expect(results.every(r => r.status === 'pass')).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); // No /compute
  });

  it('fail then converge: 1 /compute call, final pass', async () => {
    vi.mocked(runC1)
      .mockResolvedValueOnce(FAIL('retail'))   // initial 7-day: fail
      .mockResolvedValueOnce(PASS('retail'));   // single-day recheck: pass

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-2',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
    expect(fetch).toHaveBeenCalledTimes(1); // 1 /compute call
  });

  it('fail 3 retries then give up: 3 /compute calls, final fail', async () => {
    vi.mocked(runC1).mockResolvedValue(FAIL('retail')); // Always fail

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-3',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('fail');
    expect(fetch).toHaveBeenCalledTimes(3); // 3 /compute calls (MAX_RETRIES)
  });

  it('does not exceed MAX_RETRIES=3 even if still failing', async () => {
    vi.mocked(runC1).mockResolvedValue(FAIL('delivery'));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-4',
      trigger: 'cron',
      checks: ['C1:delivery'],
    });

    expect(results[0].status).toBe('fail');
    // initial runC1 + 3 retries = 4 total runC1 calls
    expect(runC1).toHaveBeenCalledTimes(4);
    // Exactly 3 /compute calls (not 4+)
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('error handling: runC1 throws -> error result, no retry', async () => {
    vi.mocked(runC1).mockRejectedValue(new Error('duckdb connection failed'));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-5',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(fetch).not.toHaveBeenCalled(); // No /compute on error
  });

  it('no-data: runC1 throws No files found -> no-data（数据未到，非 error）', async () => {
    vi.mocked(runC1).mockRejectedValue(new Error('duckdb: No files found that match the pattern ...'));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-nodata',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no-data');
    expect(results[0].diff).toBeNull();
    expect((results[0].detail as any[])[0].error).toContain('No files found');
    expect(fetch).not.toHaveBeenCalled(); // no-data 不触发 /compute 重算
  });

  it('checks filter: C1:retail only checks retail source', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-6',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].check_name).toBe('retail');
    expect(runC1).toHaveBeenCalledTimes(1);
  });

  it('checks filter: C1 (bare) checks all sources', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-7',
      trigger: 'manual',
      checks: ['C1'],
    });

    expect(results).toHaveLength(6); // all 6 sources (含 item_sales / wholesale_customer / item_outbound)
  });

  it('checks filter: C1:item_sales runs only item_sales source', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    const results = await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-item',
      trigger: 'manual',
      checks: ['C1:item_sales'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].check_name).toBe('item_sales');
    expect(runC1).toHaveBeenCalledTimes(1);
  });

  it('M19: item_sales（iso 目录）window 传入时 glob 缩为当日分区', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-item-glob',
      trigger: 'collect',
      checks: ['C1:item_sales'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    const callArg = vi.mocked(runC1).mock.calls[0][0];
    expect(callArg.glob).toContain('2026-08-05');
    expect(callArg.glob).not.toContain('*-*-*');
  });

  it('M19: wholesale_customer（compact 目录）window 传入时 glob 缩为当日分区', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-wc-glob',
      trigger: 'collect',
      checks: ['C1:wholesale_customer'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    const callArg = vi.mocked(runC1).mock.calls[0][0];
    expect(callArg.glob).toBe('s3://lemeng-datasource/lemeng/wholesale_detail/*/20260805/all.parquet');
  });

  it('writes qa_logs for each result', async () => {
    const db = makeDb();
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    await runC1Checks({
      db: db as any,
      duck: makeDuck() as any,
      runId: 'test-run-8',
      trigger: 'manual',
      checks: ['C1:retail'],
    });

    expect(db.from).toHaveBeenCalledWith('qa_logs');
    expect(db.from().insert).toHaveBeenCalledTimes(1);
  });

  it('M19: window 传入时 glob 缩为当日分区（buildDayGlob）', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-glob',
      trigger: 'collect',
      checks: ['C1:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    // runC1 被调用时 src.glob 应缩为当日分区（retail=iso 格式 2026-08-05）
    const callArg = vi.mocked(runC1).mock.calls[0][0];
    expect(callArg.glob).toContain('2026-08-05');
    expect(callArg.glob).not.toContain('*-*-*');
  });

  it('M19: 无 window 时 glob 保持原值（7 天全扫）', async () => {
    vi.mocked(runC1).mockImplementation(async (src) => PASS(src.name));

    await runC1Checks({
      db: makeDb() as any,
      duck: makeDuck() as any,
      runId: 'test-run-glob2',
      trigger: 'cron',
      checks: ['C1:retail'],
    });

    const callArg = vi.mocked(runC1).mock.calls[0][0];
    expect(callArg.glob).toBe('s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet');
  });
});
