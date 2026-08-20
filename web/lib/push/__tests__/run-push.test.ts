/**
 * run_push 引擎核心测试
 *
 * 覆盖十不变量：
 * 1. getPerms 全部走 strict 注入
 * 4. cost 脱敏
 * 9. owner 校验
 * 10. Novu 故障 → fallback
 * + 就绪守卫
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock 外部依赖
vi.mock('../novu-client', () => ({
  triggerBulk: vi.fn().mockResolvedValue({ total: 2, batches: 1, errors: [], failedSubscribers: [] }),
  upsertSubscriber: vi.fn().mockResolvedValue({ subscriberId: 'u1' }),
  newBridgeToken: vi.fn().mockReturnValue('bt-new'),
  generateEngineSig: vi.fn().mockResolvedValue('mock-sig'),
  contentDigest: vi.fn().mockResolvedValue('mock-digest'),
}));

vi.mock('../../wecom-send', () => ({
  sendWecomMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../audit', () => ({
  auditPushTrigger: vi.fn().mockResolvedValue(undefined),
  auditPushPayload: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../guards', () => ({
  isPaused: vi.fn().mockResolvedValue(false),
}));

// mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('runPush', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // 重置 push-variables 缓存
    const { resetCache } = await import('../push-variables');
    resetCache();

    // 设置必要的环境变量
    vi.stubEnv('POSTGREST_URL', 'http://localhost:3000');
    vi.stubEnv('POSTGREST_ANON_KEY', 'test-key');
    vi.stubEnv('JWT_SECRET', 'test-jwt-secret-for-testing-only');
    vi.stubEnv('ENGINE_BRIDGE_SECRET', 'test-engine-secret');
    vi.stubEnv('NOVU_API_URL', 'http://novu:3000');
    vi.stubEnv('NOVU_API_KEY', 'test-novu-key');
    vi.stubEnv('NOVU_BRIDGE_SECRET', 'test-bridge-secret');
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
      { var_code: 'cost_amount', name: '成本额', metric_code: 'cost_amount', scope_dim: 'total', unit: '元', enabled: true },
      { var_code: 'profit_amount', name: '利润额', metric_code: 'profit_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));

    // 默认 fetch mock
    mockFetch.mockImplementation((url: string) => {
      // org_users (selector resolve) — 必须在 get_user_perms_strict 之前检查
      if (url.includes('org_users?is_active=eq.true')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10, bridge_token: 'bt1' },
              { id: 'u2', wecom_id: 'wx2', is_active: true, dept_id: 10, bridge_token: 'bt2' },
            ]),
        });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10, bridge_token: 'bt1' },
              { id: 'u2', wecom_id: 'wx2', is_active: true, dept_id: 10, bridge_token: 'bt2' },
            ]),
        });
      }
      // get_user_perms_strict —— migration 170 返回标量 JSONB，PostgREST 直接以对象作 body（非数组）
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              brands: ['3120'],
              branch_nums: ['*'],
              categories: ['水果'],
              can_see_cost: true,
            }),
        });
      }
      // require_push_owner —— migration 177 RETURNS TABLE → PostgREST 数组包裹
      if (url.includes('require_push_owner')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ paused: false }]),
        });
      }
      // push_subscriber_tokens（getRecipientInfo 读取）
      if (url.includes('push_subscriber_tokens')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ bridge_token: 'bt1' }]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shadow 模式不调用 Novu trigger', async () => {
    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test-workflow',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
      deliver: false, // shadow
    });

    expect(result.mode).toBe('shadow');
    expect(result.txnId).toBeTruthy();

    // 不应调用 triggerBulk
    const { triggerBulk } = await import('../novu-client');
    expect(triggerBulk).not.toHaveBeenCalled();
  });

  it('paused → 不投递', async () => {
    const { isPaused } = await import('../guards');
    vi.mocked(isPaused).mockResolvedValueOnce(true);

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
    });

    expect(result.error).toContain('暂停');
  });

  it('owner 校验失败 → 抛错', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({
          ok: false,
          text: () => Promise.resolve('permission denied'),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { runPush } = await import('../index');
    await expect(
      runPush({
        workflowId: 'test',
        selector: { kind: 'all' },
        operatorId: 'bad-user',
        broadcastPerm: true,
      })
    ).rejects.toThrow('owner 校验失败');
  });

  it('cost 脱敏：can_see_cost=false + cost_sensitive → （无权限查看）', async () => {
    // mock perms 无成本权限
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              brands: ['3120'],
              branch_nums: ['*'],
              categories: ['水果'],
              can_see_cost: false, // ← 无成本权限
            }),
        });
      }
      if (url.includes('org_users?is_active=eq.true')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10, bridge_token: 'bt1' },
            ]),
        });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10, bridge_token: 'bt1' },
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
      deliver: false,
    });

    expect(result.groups).toBe(1);

    // 检查 audit payload 中 cost 变量被脱敏
    const { auditPushPayload } = await import('../audit');
    const call = vi.mocked(auditPushPayload).mock.calls[0];
    expect(call).toBeTruthy();
    if (call) {
      const record = call[0] as { txnId: string; groupSig: string; payload: Record<string, string> };
      // cost/profit 变量应该是脱敏值
      for (const [key, value] of Object.entries(record.payload)) {
        if (key.includes('cost') || key.includes('profit')) {
          expect(value).toBe('（无权限查看）');
        }
      }
    }
  });

  it('无有效收件人 → 返回错误', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }); // 空
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
    });

    expect(result.error).toContain('无有效收件人');
  });

  it('Novu 故障 → fallback 触发（只补失败收件人）', async () => {
    // live 模式占位符守卫（M7）：数值变量仍是 {{code}} 占位 → 拒绝投递；
    // 本测试用 URL-only 变量集验证 fallback 路径。
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'detail_url', name: '明细', metric_code: null, scope_dim: 'total', unit: null, enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    const { triggerBulk } = await import('../novu-client');
    vi.mocked(triggerBulk).mockResolvedValueOnce({
      total: 2,
      batches: 1,
      errors: ['batch 0: 500'],
      failedSubscribers: ['wx1', 'wx2'],
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
      deliver: true,
    });

    expect(result.fallbackUsed).toBe(true);
    const { sendWecomMarkdown } = await import('../../wecom-send');
    expect(sendWecomMarkdown).toHaveBeenCalled();
  });

  it('live 模式数值变量 §12.1：无 DB 取不到 → 跳过不渲染，不拒投递（字面占位符仍 M7 拒绝）', async () => {
    // 默认 PUSH_VARIABLES_JSON 含 sale_amount/cost_amount/profit_amount（数值变量）。
    // §12.1（2026-08-20）：数值变量用代签 JWT 查语义视图取真值；无 DB/取不到 → null → 变量跳过，
    //   不再产生 {{code}} 占位符 → M7 fail-closed 不触发（M7 仅兜底字面占位符）。
    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'all' },
      operatorId: 'admin',
      broadcastPerm: true,
      deliver: true,
    });
    expect(result).toHaveProperty('txnId');
    expect(result.error).toBeUndefined();
  });

  it('§12.1 数值取当前 active 周期单行（回归：跨周期 SUM 出 7月+8月=81.7% 假达成率）', async () => {
    // 2026-08-20 生产 bug：resolveNumericValue 对 metric_code=eq.sale 无 status 过滤直接 SUM 全部行，
    //   7月 closed(104.4%) + 8月 active(60.6%) 加总出 81.7% 假达成率。
    // 修复：只取 status=active 单行；rate 用视图 achievement_rate（与报表页同口径），金额用 actual_value。
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
      { var_code: 'sale_rate', name: '销售达成率', metric_code: 'sale_rate', scope_dim: 'total', unit: '%', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    // 模拟视图（已按 URL 过滤条件返回 active 8月单行——若查询漏 status 过滤本测试的 URL 断言会拦下）
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: 'u1', wecom_id: 'wx1', is_active: true },
          ]),
        });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }),
        });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { metric_code: 'sale', actual_value: 4164063.06, target_value: 6873288, achievement_rate: 0.6058 },
          ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'test',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
    });

    // 1. 查询必须带 active 周期过滤 + 单行截断（防回归 SUM 全部行）
    const genCalls = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('report_achievement_gen'));
    expect(genCalls.length).toBeGreaterThan(0);
    for (const url of genCalls) {
      expect(url).toContain('status=eq.active');
      expect(url).toContain('limit=1');
      expect(url).toContain('order=start_date.desc');
    }

    // 2. 渲染值 = 8月单周期（¥4,164,063 / 60.6%），非跨周期合计（¥10,843,212 / 81.7%）
    const rendered = result.renderedGroups?.[0]?.rendered ?? {};
    expect(rendered.sale_amount).toBe('¥4,164,063');
    expect(rendered.sale_rate).toBe('60.6%');
  });

  it('follow 模式取值 URL 带「今天落区间」过滤 + tie-break（回归：最新≠进行中）', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([
          { actual_value: 4200000, achievement_rate: 0.61 },
        ]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    await runPush({
      workflowId: 'scheduled-report',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
      targetMode: 'follow',
    });

    const genCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('report_achievement_gen'));
    expect(genCalls.length).toBeGreaterThan(0);
    for (const url of genCalls) {
      expect(url).toContain('status=eq.active');
      expect(url).toMatch(/start_date=lte\.\d{4}-\d{2}-\d{2}/);
      expect(url).toMatch(/end_date=gte\.\d{4}-\d{2}-\d{2}/);
      expect(url).toContain('order=start_date.desc,end_date.asc');
      expect(url).toContain('limit=1');
    }
  });

  it('fixed 模式取值 URL 带 target_id 过滤', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ actual_value: 100, achievement_rate: 0.5 }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    await runPush({
      workflowId: 'scheduled-report',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
      targetMode: 'fixed',
      targetId: 823,
    });

    const genCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('report_achievement_gen'));
    for (const url of genCalls) {
      expect(url).toContain('target_id=eq.823');
      expect(url).not.toContain('start_date=lte');
    }
  });

  it('presetId 直取：preset 查询按 preset_id 而非 workflow_id', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('push_message_presets')) {
        if (url.includes('preset_id=eq.preset-xyz')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([
            { preset_id: 'preset-xyz', workflow_id: 'w', msgtype: 'template_card', card_json: { card_type: 'news_notice', main_title: { title: 'X {{sale_amount}}' } }, enabled: true },
          ]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ actual_value: 42, achievement_rate: 0.5 }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'scheduled-report',
      presetId: 'preset-xyz',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
    });

    expect(result.renderedGroups?.[0]?.rendered.message_content).toContain('X ¥42');
  });
});
