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

    expect(results).toHaveLength(3); // retail, delivery, wholesale
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

    expect(results).toHaveLength(3); // all 3 sources
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
});
