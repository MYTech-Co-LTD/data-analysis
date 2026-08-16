// web/lib/__tests__/exception-grants.test.ts
// B5：例外不折叠进登录 claims；M3：5min TTL 缓存 + UI 撤销同步失效；本地降级 = fail-close 等同无例外。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mod = await import('../exception-grants');

describe('例外 RT 实查（B5/M3）', () => {
  beforeEach(() => { mod.__resetForTest(); vi.restoreAllMocks(); });

  it('活跃且未过期/未撤销的例外计入；过期/已撤销不计入', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ([
        { dim: 'branch_nums', value: '3120-001', expires_at: future, revoked_at: null },
        { dim: 'branch_nums', value: '3120-002', expires_at: past, revoked_at: null },
        { dim: 'fields', value: 'cost', expires_at: future, revoked_at: past },
      ]),
    } as never);
    const g = await mod.getExceptionGrants('shanhai/zhangsan');
    expect(g.branch_nums).toEqual(['3120-001']);
    expect(g.can_see_cost).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('5min TTL：缓存期内二次调用零请求；invalidate 后立即重查（主动失效）', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as never);
    await mod.getExceptionGrants('shanhai/a');
    await mod.getExceptionGrants('shanhai/a');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    mod.invalidateExceptionCache('shanhai/a');
    await mod.getExceptionGrants('shanhai/a');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('查询失败 → fail-close 等同无例外（空 grants，不抛不兜底放行）', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('db down'));
    const g = await mod.getExceptionGrants('shanhai/a');
    expect(g).toEqual({ branch_nums: [], brands: [], categories: [], can_see_cost: false });
  });
});
