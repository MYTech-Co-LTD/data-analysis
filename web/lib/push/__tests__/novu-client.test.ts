/**
 * novu-client triggerBulk 逐 event overrides 契约测试（生产接线 2026-08-18）
 *
 * Novu 3.19 投递契约（源码 send-message-chat.usecase.ts:533 + base.provider.ts）：
 * - webhookUrl 必须 = overrides.providers['chat-webhook'].webhookUrl
 * - engine_sig 等四字段必须经 _passthrough.body 透传（snake_case 原样；
 *   顶层会被 camelCase 变换 → bridge 双层验签必然失败）
 * - payload 冗余携带四字段（审计/调试，不参与投递 body）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock node:crypto（generateEngineSig/contentDigest 依赖）
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (n: number) => Buffer.alloc(n, 0x61),
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('triggerBulk 逐 event overrides（Novu 3.19 投递契约）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('NOVU_API_URL', 'http://novu:3000');
    vi.stubEnv('NOVU_API_KEY', 'test-novu-key');
    vi.stubEnv('ENGINE_BRIDGE_SECRET', 'test-engine-secret');
    vi.stubEnv('PUSH_BRIDGE_BASE_URL', 'https://data.example.com/api/wecom-bridge/');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    } as Response);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('bridgeToken → 每 event 带 providers.chat-webhook.webhookUrl + _passthrough.body', async () => {
    const { triggerBulk } = await import('../novu-client');
    await triggerBulk(
      'scheduled_report',
      [
        { subscriberId: 'wx1', payload: { sale_amount_url: 'u1' }, bridgeToken: 'bt1' },
        { subscriberId: 'wx2', payload: { sale_amount_url: 'u2' }, bridgeToken: 'bt2' },
      ],
      'txn-123',
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://novu:3000/v1/events/trigger/bulk');
    const body = JSON.parse(init.body as string) as { events: Array<Record<string, unknown>> };
    expect(body.events).toHaveLength(2);

    for (const [i, bt] of ['bt1', 'bt2'].entries()) {
      const ev = body.events[i];
      // webhookUrl：基址（去尾斜杠）+ bridge_token 路径段
      const providers = (ev.overrides as { providers: Record<string, Record<string, unknown>> })
        .providers['chat-webhook'];
      expect(providers.webhookUrl).toBe(
        `https://data.example.com/api/wecom-bridge/${bt}`,
      );
      // _passthrough.body：snake_case 原样透传四字段
      const passthrough = providers._passthrough as { body: Record<string, string> };
      expect(passthrough.body.txn_id).toBe('txn-123');
      expect(passthrough.body.subscriber_id).toBe(`wx${i + 1}`);
      expect(typeof passthrough.body.engine_sig).toBe('string');
      expect(passthrough.body.engine_sig.length).toBeGreaterThan(0);
      expect(passthrough.body.engine_content).toContain(`wx${i + 1}`);
      // payload 冗余携带（审计）
      expect((ev.payload as Record<string, unknown>).txn_id).toBe('txn-123');
    }

    // 两人 sig 不同（逐人签名）
    const sig1 = ((body.events[0].overrides as { providers: Record<string, { _passthrough: { body: Record<string, string> } }> })
      .providers['chat-webhook']._passthrough.body.engine_sig);
    const sig2 = ((body.events[1].overrides as { providers: Record<string, { _passthrough: { body: Record<string, string> } }> })
      .providers['chat-webhook']._passthrough.body.engine_sig);
    expect(sig1).not.toBe(sig2);
  });

  it('无 bridgeToken → 不构造 overrides.providers（不破坏非桥接场景）', async () => {
    const { triggerBulk } = await import('../novu-client');
    await triggerBulk('w', [{ subscriberId: 'wx1', payload: {} }]);
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.events[0].overrides).toBeUndefined();
    expect(body.events[0].payload.engine_sig).toBeTruthy();
  });

  it('Novu 未配置 → 抛错（fail-closed）', async () => {
    vi.stubEnv('NOVU_API_URL', '');
    const { triggerBulk } = await import('../novu-client');
    await expect(triggerBulk('w', [{ subscriberId: 'wx1', payload: {} }])).rejects.toThrow(
      /config missing/,
    );
  });
});
