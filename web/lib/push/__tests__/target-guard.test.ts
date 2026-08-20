// web/lib/push/__tests__/target-guard.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wecom-send', () => ({
  sendWecomMarkdown: vi.fn().mockResolvedValue({ ok: true, errcode: 0, errmsg: '', sent_to: 'x', msgtype: 'markdown' }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('target-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POSTGREST_URL', 'http://localhost:3000');
    vi.stubEnv('POSTGREST_ANON_KEY', 'test-key');
    vi.stubEnv('WECOM_CORP_ID', 'c');
    vi.stubEnv('WECOM_OPS_SECRET', 's');
    vi.stubEnv('WECOM_OPS_AGENT_ID', '1');
  });

  it('follow：今天落区间有行 → active', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ metric_code: 'sale' }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    expect(await checkTargetActive('follow', undefined)).toEqual({ active: true, reason: '' });
  });

  it('follow：无进行中行 → inactive（查询带区间过滤断言）', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    const r = await checkTargetActive('follow', undefined);
    expect(r.active).toBe(false);
    expect(r.reason).toContain('无进行中目标');
    const call = String(mockFetch.mock.calls.find((c) => String(c[0]).includes('report_achievement_gen'))?.[0]);
    expect(call).toMatch(/start_date=lte\.\d{4}-\d{2}-\d{2}/);
    expect(call).toMatch(/end_date=gte\.\d{4}-\d{2}-\d{2}/);
  });

  it('fixed：目标 status=active → active；closed → inactive', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('targets?id=eq.823')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 823, status: 'closed' }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    const r = await checkTargetActive('fixed', 823);
    expect(r.active).toBe(false);
    expect(r.reason).toContain('已结束');
  });

  it('notifyOwnerOnce：24h 内已提醒过 → 不重发', async () => {
    mockFetch.mockImplementation((url: string) => {
      // 防重读取：返回 1 小时前提醒过
      if (String(url).includes('push_configs?config_id=eq')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ last_guard_notice_at: new Date(Date.now() - 3600_000).toISOString() }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { notifyOwnerOnce } = await import('../target-guard');
    const { sendWecomMarkdown } = await import('../../wecom-send');
    await notifyOwnerOnce({ configId: 'c1', ownerWecomId: 'ZhangDuo', name: '每日销售日报' });
    expect(sendWecomMarkdown).not.toHaveBeenCalled();
  });
});
