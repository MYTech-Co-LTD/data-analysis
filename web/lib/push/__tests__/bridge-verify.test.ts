/**
 * bridge-verify 测试
 *
 * 覆盖场景：
 * ① 无签名拒
 * ② 错误 token 拒
 * ③ engine_sig 缺失拒
 * ④ nonce 重放拒（同 token+body 二次）
 * ⑤ 跨 token 移植拒（tokenA 的 body+sig 打 tokenB 路径）——Review M1 修复后必拒
 * ⑥ 成功验签返回 wecomId
 * ⑦ engine_sig 生产端与验证端共享实现（B5 交叉验证：generateEngineSig 输出 → verifyBridge 通过）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { verifyBridge } from '../bridge-verify';
// B5 修复：测试用真实生产端签名实现（共享 engine-sig.ts），不再自造一套约定
import { generateEngineSig, contentDigest } from '../engine-sig';

vi.stubEnv('NOVU_BRIDGE_SECRET', 'test-novu-secret');
vi.stubEnv('ENGINE_BRIDGE_SECRET', 'test-engine-secret');

function hmacSha256Hex(data: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

const TOKEN = 'valid-token';

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    content: '测试消息内容',
    webhookUrl: `https://example.com/api/wecom-bridge/${TOKEN}`,
    channel: 'chat-webhook',
    txn_id: 'txn_123',
    subscriber_id: 'sub_456',
    engine_content: '{"subscriberId":"sub_456","payload":{"sale_amount":"100"}}',
    engine_sig: '', // 占位，下面计算
    ...overrides,
  };
}

/**
 * 用「生产端共享实现」签名（generateEngineSig + contentDigest 来自 engine-sig.ts），
 * 再套外层 Novu 签名。这样测试验证的是真实端到端约定，而非测试自己的约定。
 */
function signBody(body: Record<string, unknown>, novuSecret: string) {
  // engine_sig 由生产端共享实现生成（读取 env ENGINE_BRIDGE_SECRET），不再手工算
  const txnId = (body.txn_id as string) ?? (body.transactionId as string) ?? '';
  const subscriberId = (body.subscriber_id as string) ?? (body.subscriberId as string) ?? '';
  const content = (body.engine_content as string) ?? (body.content as string) ?? '';
  const digest = contentDigest(content);
  body.engine_sig = generateEngineSig(txnId, subscriberId, digest);

  const rawBody = JSON.stringify(body);
  const novuSig = hmacSha256Hex(rawBody, novuSecret);

  return { rawBody: Buffer.from(rawBody), novuSig };
}

const mockGetWecomIdByToken = vi.fn(async (token: string) => {
  if (token === TOKEN) return 'test-wecom-id';
  return null;
});

describe('verifyBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('① 无签名拒', async () => {
    const result = await verifyBridge({
      bridgeToken: TOKEN,
      rawBody: Buffer.from('{}'),
      headers: {},
      getWecomIdByToken: mockGetWecomIdByToken,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing or invalid X-Novu-Signature');
  });

  it('② 错误 token 拒（unknown bridge_token）', async () => {
    const body = makeBody({ webhookUrl: 'https://example.com/api/wecom-bridge/wrong-token' });
    const { rawBody, novuSig } = signBody(body, 'test-novu-secret');

    const result = await verifyBridge({
      bridgeToken: 'wrong-token',
      rawBody,
      headers: { 'x-novu-signature': novuSig },
      getWecomIdByToken: mockGetWecomIdByToken,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown bridge_token');
  });

  it('②b webhookUrl 路径段与请求 token 不符 → 拒（M1）', async () => {
    const body = makeBody(); // webhookUrl 指向 valid-token
    const { rawBody, novuSig } = signBody(body, 'test-novu-secret');

    const result = await verifyBridge({
      bridgeToken: 'other-token', // 请求路径是 other-token，但 body.webhookUrl 是 valid-token
      rawBody,
      headers: { 'x-novu-signature': novuSig },
      getWecomIdByToken: mockGetWecomIdByToken,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('webhookUrl token mismatch');
  });

  it('③ engine_sig 缺失拒', async () => {
    const body = makeBody({ engine_sig: undefined });
    const rawBody = JSON.stringify(body);
    const novuSig = hmacSha256Hex(rawBody, 'test-novu-secret');

    const result = await verifyBridge({
      bridgeToken: TOKEN,
      rawBody: Buffer.from(rawBody),
      headers: { 'x-novu-signature': novuSig },
      getWecomIdByToken: mockGetWecomIdByToken,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('engine_sig');
  });

  it('④ nonce 重放拒（同 token+body 二次）', async () => {
    const body = makeBody({ content: `replay-test-${Date.now()}` });
    const { rawBody, novuSig } = signBody(body, 'test-novu-secret');

    const headers = { 'x-novu-signature': novuSig };
    const opts = {
      bridgeToken: TOKEN,
      rawBody,
      headers,
      getWecomIdByToken: mockGetWecomIdByToken,
    };

    const first = await verifyBridge(opts);
    expect(first.ok).toBe(true);

    const second = await verifyBridge(opts);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('nonce replay');
  });

  it('⑤ 跨 token 移植拒（tokenA 的 body+sig 打 tokenB 路径）', async () => {
    // tokenA 的 body 里 webhookUrl 含 tokenA
    const bodyA = makeBody({
      content: `cross-token-test-${Date.now()}`,
      webhookUrl: 'https://example.com/api/wecom-bridge/token-a',
      txn_id: `txn-cross-${Date.now()}`,
    });
    const { rawBody: rawBodyA, novuSig: novuSigA } = signBody(
      bodyA,
      'test-novu-secret'
    );

    const mockGetWecomIdForB = vi.fn(async (token: string) => {
      if (token === 'token-b') return 'wecom-b';
      return null;
    });

    const result = await verifyBridge({
      bridgeToken: 'token-b', // 路径是 tokenB
      rawBody: rawBodyA, // body 是 tokenA 的
      headers: { 'x-novu-signature': novuSigA },
      getWecomIdByToken: mockGetWecomIdForB,
    });

    // M1 修复：body.webhookUrl 路径段 ≠ 请求路径 → 拒（不再允许移植到其他用户）
    expect(result.ok).toBe(false);
    expect(result.error).toBe('webhookUrl token mismatch');
  });

  it('⑥ 成功验签返回 wecomId', async () => {
    const body = makeBody({ content: `success-test-${Date.now()}` });
    const { rawBody, novuSig } = signBody(body, 'test-novu-secret');

    const result = await verifyBridge({
      bridgeToken: TOKEN,
      rawBody,
      headers: { 'x-novu-signature': novuSig },
      getWecomIdByToken: mockGetWecomIdByToken,
    });

    expect(result.ok).toBe(true);
    expect(result.wecomId).toBe('test-wecom-id');
  });

  it('⑦ engine_sig 生产端（engine-sig.ts）输出可被 bridge 验证（B5 交叉验证）', async () => {
    // 模拟 novu-client.triggerBulk 的完整签名路径：
    const txnId = 'txn-prod-001';
    const subscriberId = 'wx-10086';
    const engineContent = JSON.stringify({ subscriberId, payload: { sale_amount: '100' } });
    const digest = contentDigest(engineContent);
    const sig = generateEngineSig(txnId, subscriberId, digest);

    const body = makeBody({
      webhookUrl: `https://example.com/api/wecom-bridge/${TOKEN}`,
      txn_id: txnId,
      subscriber_id: subscriberId,
      engine_content: engineContent,
      engine_sig: sig,
    });
    const rawBody = JSON.stringify(body);
    const novuSig = hmacSha256Hex(rawBody, 'test-novu-secret');

    const result = await verifyBridge({
      bridgeToken: TOKEN,
      rawBody: Buffer.from(rawBody),
      headers: { 'x-novu-signature': novuSig },
      getWecomIdByToken: mockGetWecomIdByToken,
    });
    expect(result.ok).toBe(true);
  });
});
