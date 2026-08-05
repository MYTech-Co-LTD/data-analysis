// web/lib/qa/__tests__/c0-runner.test.ts
// C0 runner 单测：mock count API + runC0 + runCollectBackfill，
// 验证 window 参数（默认 7 天 / 单日当日）+ autoBackfill 收敛（missing → full 重采 ≤3 retry）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock 外部依赖（不测 count/runC0 核心本身，只测 runner 编排 + window + backfill retry 逻辑）
vi.mock('@/lib/collect', () => ({
  countRetailApi: vi.fn(),
  decodeCompanyId: vi.fn(() => '3120'),
  getDateOffsetChina: vi.fn(),
}));
vi.mock('@/lib/collect-delivery', () => ({ countDeliveryApi: vi.fn() }));
vi.mock('@/lib/collect-wholesale', () => ({ countWholesaleApi: vi.fn() }));
vi.mock('@/lib/collect-backfill', () => ({ runCollectBackfill: vi.fn() }));
vi.mock('@/lib/qa/c0', () => ({ runC0: vi.fn() }));

import { countRetailApi, getDateOffsetChina } from '@/lib/collect';
import { runCollectBackfill } from '@/lib/collect-backfill';
import { runC0 } from '@/lib/qa/c0';
import { runC0Checks } from '../c0-runner';
import type { CheckResult } from '../types';

function makeClient(opts?: { tasksEmpty?: boolean }) {
  const insert = vi.fn().mockResolvedValue({ data: null });
  const from = vi.fn((table: string) => {
    if (table === 'collect_tasks') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({
            data: opts?.tasksEmpty ? [] : [{ source_id: 'src-1', params: { branch_nums: [1, 2] } }],
          }),
        })),
      };
    }
    if (table === 'auth_credentials') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { credential_data: JSON.stringify({ token: 'tok' }) } }),
          })),
        })),
      };
    }
    return { insert };
  });
  return { database: { from }, insert };
}

function makeDuck() {
  return vi.fn().mockResolvedValue([{ c: 100 }]);
}

const PASS = (day: string): CheckResult => ({
  run_id: '', trigger: 'manual', check_type: 'C0', check_name: 'retail',
  status: 'pass', diff: 0, detail: null,
});
const MISSING = (day: string): CheckResult => ({
  run_id: '', trigger: 'manual', check_type: 'C0', check_name: 'retail',
  status: 'fail', diff: -10,
  detail: [{ day, api: 100, lib: 90, verdict: 'missing' }],
});
const DUP = (day: string): CheckResult => ({
  run_id: '', trigger: 'manual', check_type: 'C0', check_name: 'retail',
  status: 'fail', diff: 100,
  detail: [{ day, api: 100, lib: 200, verdict: 'dup-suspect' }],
});

describe('runC0Checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countRetailApi).mockResolvedValue(100);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('window 单日：只查当日一次，check_name 含品牌+日期', async () => {
    vi.mocked(runC0).mockResolvedValue(PASS('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r1',
      trigger: 'collect',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    expect(res).toHaveLength(1);
    expect(runC0).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runC0).mock.calls[0][1]).toBe('2026-08-05');
    expect(res[0].check_name).toBe('retail:3120:2026-08-05');
    expect(res[0].status).toBe('pass');
  });

  it('无 window：默认 7 天回溯（昨天往前 7 天）', async () => {
    vi.mocked(getDateOffsetChina).mockImplementation((n: number) => {
      const d = new Date('2026-08-05T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    });
    vi.mocked(runC0).mockResolvedValue(PASS('x'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r2',
      trigger: 'cron',
      checks: ['C0:retail'],
    });

    expect(res).toHaveLength(7);
    expect(runC0).toHaveBeenCalledTimes(7);
    // 7 天应为 [2026-07-29 .. 2026-08-04]（昨天往前 7 天）
    const days = vi.mocked(runC0).mock.calls.map((c) => c[1]);
    expect(days[0]).toBe('2026-07-29');
    expect(days[6]).toBe('2026-08-04');
  });

  it('无 checks：三源都跑（单日窗口 → 3 结果）', async () => {
    vi.mocked(runC0).mockResolvedValue(PASS('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r3',
      trigger: 'collect',
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    expect(res).toHaveLength(3); // retail + delivery + wholesale
    expect(res.every((r) => r.status === 'pass')).toBe(true);
  });

  it('autoBackfill：missing → full 重采一次即收敛，只落最终 pass 结果', async () => {
    vi.mocked(runC0)
      .mockResolvedValueOnce(MISSING('2026-08-05'))
      .mockResolvedValueOnce(PASS('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r4',
      trigger: 'collect',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
      autoBackfill: true,
    });

    expect(runCollectBackfill).toHaveBeenCalledTimes(1);
    expect(runCollectBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: 'src-1' }),
      'Bearer tok',
      '2026-08-05',
      '2026-08-05',
    );
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('pass');
  });

  it('autoBackfill：仍 missing → ≤3 retry 后放弃，保留 fail', async () => {
    vi.mocked(runC0).mockResolvedValue(MISSING('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r5',
      trigger: 'collect',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
      autoBackfill: true,
    });

    expect(runCollectBackfill).toHaveBeenCalledTimes(3); // MAX_RETRIES=3
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('fail');
  });

  it('autoBackfill 默认 false：missing 不触发补采', async () => {
    vi.mocked(runC0).mockResolvedValue(MISSING('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r6',
      trigger: 'collect',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    expect(runCollectBackfill).not.toHaveBeenCalled();
    expect(res[0].status).toBe('fail');
  });

  it('autoBackfill：dup-suspect 不触发补采（只补 missing）', async () => {
    vi.mocked(runC0).mockResolvedValue(DUP('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r7',
      trigger: 'collect',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
      autoBackfill: true,
    });

    expect(runCollectBackfill).not.toHaveBeenCalled();
    expect(res[0].status).toBe('fail');
    expect((res[0].detail as any[])[0].verdict).toBe('dup-suspect');
  });

  it('item 源跳过：C0:item_sales 不产生结果（无 collect 任务）', async () => {
    vi.mocked(runC0).mockResolvedValue(PASS('2026-08-05'));

    const res = await runC0Checks({
      client: makeClient() as any,
      duck: makeDuck() as any,
      runId: 'r9',
      trigger: 'collect',
      checks: ['C0:item_sales'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    expect(res).toHaveLength(0);
    expect(runC0).not.toHaveBeenCalled();
    expect(countRetailApi).not.toHaveBeenCalled();
  });

  it('无 collect_tasks → error 结果，不写 qa_logs', async () => {
    vi.mocked(runC0).mockResolvedValue(PASS('x'));

    const res = await runC0Checks({
      client: makeClient({ tasksEmpty: true }) as any,
      duck: makeDuck() as any,
      runId: 'r8',
      trigger: 'manual',
      checks: ['C0:retail'],
      window: { from: '2026-08-05', to: '2026-08-05' },
    });

    expect(res).toHaveLength(1);
    expect(res[0].status).toBe('error');
    expect(runC0).not.toHaveBeenCalled();
  });
});
