// web/lib/jobs/scheduled-reports/__tests__/manifest.test.ts
// 终审 C2/I2 回归：scheduled_reports 调度 manifest。
//   C2：due 必须含 isTimeReached（配置的 time 参与判定——否则「每天 08:30」在 00:00 就触发）
//   I2：today 用北京日界（UTC+8），北京 00-08 窗口内 last_run_date（UTC 串）不跨日误判
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../scheduler-lock', () => ({
  tryAcquireLock: vi.fn(),
}));

vi.mock('../../../push/target-guard', () => ({
  checkTargetActive: vi.fn().mockResolvedValue({ active: true, reason: '' }),
  notifyOwnerOnce: vi.fn().mockResolvedValue(undefined),
  listActiveTargets: vi.fn().mockResolvedValue([]),
}));

import { scheduledReportsManifest } from '../manifest';
import type { JobContext } from '../../../contracts';
import { tryAcquireLock } from '../../../scheduler-lock';
import { checkTargetActive, listActiveTargets } from '../../../push/target-guard';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TZ = 'Asia/Shanghai';
  vi.stubEnv('POSTGREST_URL', 'http://postgrest:3000');
  vi.stubEnv('INSFORGE_API_KEY', 'test-key');
  vi.stubEnv('AGENT_API_KEY', 'test-agent-key');
  vi.stubEnv('WEB_BASE_URL', 'http://localhost:3000');
  vi.stubGlobal('fetch', mockFetch);
  vi.mocked(tryAcquireLock).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function configRow(over: Record<string, unknown>) {
  return {
    config_id: 'c1',
    name: '每日日报',
    cron_spec: { kind: 'daily', time: '08:30' },
    selector_json: { kind: 'dept', ids: ['d1'] },
    target_mode: 'follow',
    target_id: null,
    preset_id: 'p1',
    owner_wecom_id: 'ZhangDuo',
    last_run_date: null,
    ...over,
  };
}

describe('scheduledReportsManifest — 终审修复回归', () => {
  it('C2：未到配置 time（北京 00:30 配 08:30）→ 不触发 /api/push', async () => {
    vi.useFakeTimers();
    // 北京 2026-08-20 00:30 = UTC 2026-08-19 16:30
    vi.setSystemTime(new Date('2026-08-19T16:30:00.000Z'));

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('push_configs')) {
        return new Response(JSON.stringify([configRow({ last_run_date: null })]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const result = await scheduledReportsManifest.run({} as JobContext);
    expect(result.status).toBe('ok');
    const pushCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/push'));
    expect(pushCalls).toHaveLength(0);
    expect(checkTargetActive).not.toHaveBeenCalled();
  });

  it('I2：北京 00-08 窗口内 last_run_date=北京今日 → alreadyRan 跳过（不触发 /api/push）', async () => {
    vi.useFakeTimers();
    // 北京 2026-08-20 06:00 = UTC 2026-08-19 22:00（UTC 昨日）——today 必须取北京 08-20
    vi.setSystemTime(new Date('2026-08-19T22:00:00.000Z'));

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('push_configs')) {
        return new Response(JSON.stringify([
          configRow({ cron_spec: { kind: 'daily', time: '06:00' }, last_run_date: '2026-08-20' }),
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const result = await scheduledReportsManifest.run({} as JobContext);
    expect(result.status).toBe('ok');
    const pushCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/push'));
    expect(pushCalls).toHaveLength(0);
    expect(checkTargetActive).not.toHaveBeenCalled();
  });

  it('已到配置 time + 今日未跑 → 正常触发（/api/push 被调用 + last_run_date 回写）', async () => {
    vi.useFakeTimers();
    // 北京 2026-08-20 09:00 = UTC 2026-08-20 01:00（daily 08:30 已过）
    vi.setSystemTime(new Date('2026-08-20T01:00:00.000Z'));
    vi.mocked(listActiveTargets).mockResolvedValue([{ target_id: 823, name: '8月经营指标' }]);

    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('push_configs') && !u.includes('config_id=eq')) {
        return new Response(JSON.stringify([configRow({ last_run_date: null })]), { status: 200 });
      }
      if (u.includes('/api/push')) {
        return new Response(JSON.stringify({ txnId: 'txn-1', groups: 1, skipped: [] }), { status: 200 });
      }
      if (u.includes('config_id=eq')) {
        // PATCH 回写 last_run_date/last_run_txn_id（204 No Content 不能带 body）
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const result = await scheduledReportsManifest.run({} as JobContext);
    expect(result.status).toBe('ok');
    const pushCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/push'));
    expect(pushCalls).toHaveLength(1);
    expect(checkTargetActive).toHaveBeenCalledWith('follow', undefined);
    const body = JSON.parse(String(pushCalls[0][1].body));
    expect(body.targetMode).toBe('fixed');
    expect(body.targetId).toBe(823);
  });

  it('follow 扇出：2 个进行中目标 → 2 次 /api/push（各自 fixed+target_id）+ last_run_txn_id 记清单', async () => {
    vi.useFakeTimers();
    // 北京 2026-08-20 09:00（daily 08:30 已过）
    vi.setSystemTime(new Date('2026-08-20T01:00:00.000Z'));
    vi.mocked(listActiveTargets).mockResolvedValue([
      { target_id: 1402, name: '9月经营指标' },
      { target_id: 1403, name: '26年中秋经营指标' },
    ]);

    let pushSeq = 0;
    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('push_configs') && !u.includes('config_id=eq')) {
        return new Response(JSON.stringify([configRow({ last_run_date: null })]), { status: 200 });
      }
      if (u.includes('/api/push')) {
        pushSeq += 1;
        return new Response(JSON.stringify({ txnId: `txn-${pushSeq}`, groups: 1, skipped: [] }), { status: 200 });
      }
      if (u.includes('config_id=eq')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const result = await scheduledReportsManifest.run({} as JobContext);
    expect(result.status).toBe('ok');
    const pushCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/push'));
    expect(pushCalls).toHaveLength(2);
    const bodies = pushCalls.map((c) => JSON.parse(String(c[1].body)));
    expect(bodies.map((b) => b.targetId).sort()).toEqual([1402, 1403]);
    bodies.forEach((b) => expect(b.targetMode).toBe('fixed'));
    // 回写 last_run_txn_id = 两条 txn 清单
    const patches = mockFetch.mock.calls.filter((c) => String(c[0]).includes('config_id=eq') && String(c[1]?.method) === 'PATCH');
    expect(patches).toHaveLength(1);
    const patchBody = JSON.parse(String(patches[0][1].body));
    expect(patchBody.last_run_date).toBe('2026-08-20');
    expect(String(patchBody.last_run_txn_id).split(',').sort()).toEqual(['txn-1', 'txn-2']);
  });
});
