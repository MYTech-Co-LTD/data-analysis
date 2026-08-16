/**
 * wecom-bridge 双层验签模块
 *
 * 契约来源：docs/ops/novu-bridge-signature-verification.md（V1 快照）
 * - 外层：X-Novu-Signature = HMAC-SHA256-hex(rawBody, NOVU_BRIDGE_SECRET)
 * - 内层：body.engine_sig 验签（共享实现 ./engine-sig.ts，Review B5 修复）：
 *     HMAC-SHA256-hex(`${txnId}:${subscriberId}:${contentDigest}`, ENGINE_BRIDGE_SECRET)
 *     其中 txnId/subscriberId/engine_content 由引擎写入 payload（txn_id/subscriber_id/engine_content）
 *     并经 Novu workflow 透传进送达 body；兼容旧 transactionId/subscriberId/content 字段。
 * - webhookUrl 路径段必须等于请求路径的 bridge_token（Review M1：防跨 token 移植/重放）
 * - nonce 防重放：键 = `${bridge_token}:${sha256(rawBody)}`，TTL 24h（进程级；多副本需共享存储，见 NIT）
 */

import { createHmac, createHash, timingSafeEqual } from 'crypto';
import { contentDigest, verifyEngineSig } from './engine-sig';

// ---- 配置（运行时读取，支持测试 mock） ----

const NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---- nonce 缓存（内存 Map，进程级） ----

const nonceCache = new Map<string, number>();

function cleanupNonces() {
  const now = Date.now();
  for (const [key, ts] of nonceCache) {
    if (now - ts > NONCE_TTL_MS) nonceCache.delete(key);
  }
}

// 每小时清理一次
setInterval(cleanupNonces, 60 * 60 * 1000).unref();

// ---- 工具函数 ----

function hmacSha256Hex(data: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- 核心验签 ----

export interface VerifyResult {
  ok: boolean;
  wecomId?: string;
  error?: string;
}

/**
 * 验证 bridge 请求
 * @param bridgeToken - URL 路径段中的 token
 * @param rawBody - 原始请求体字节（勿 re-serialize）
 * @param headers - 请求 headers
 * @param getWecomIdByToken - 查库函数：bridge_token → wecom_id
 */
export async function verifyBridge({
  bridgeToken,
  rawBody,
  headers,
  getWecomIdByToken,
}: {
  bridgeToken: string;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  getWecomIdByToken: (token: string) => Promise<string | null>;
}): Promise<VerifyResult> {
  // 0. 检查配置（运行时读取）
  const novuBridgeSecret = process.env.NOVU_BRIDGE_SECRET || '';
  const engineBridgeSecret = process.env.ENGINE_BRIDGE_SECRET || '';
  if (!novuBridgeSecret || !engineBridgeSecret) {
    return { ok: false, error: 'bridge secrets not configured' };
  }

  // 1. 外层验签：X-Novu-Signature
  const novuSig = headers['x-novu-signature'];
  if (!novuSig || !/^[0-9a-f]{64}$/.test(novuSig)) {
    return { ok: false, error: 'missing or invalid X-Novu-Signature' };
  }

  const expectedNovuSig = hmacSha256Hex(rawBody, novuBridgeSecret);
  if (!constantTimeEqual(novuSig, expectedNovuSig)) {
    return { ok: false, error: 'X-Novu-Signature mismatch' };
  }

  // 2. 解析 body
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }

  // 2b. 防跨 token 移植（M1）：body.webhookUrl 路径段必须等于请求路径的 bridge_token。
  //     签名不绑定 URL（Novu 契约），但 webhookUrl 在被签 body 内；
  //     不校验则截获的合法 body 可重放到任意 token 路径 → 任意用户收到伪造推送。
  const webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl : '';
  if (webhookUrl) {
    try {
      const url = new URL(webhookUrl);
      const pathSeg = url.pathname.split('/').filter(Boolean).pop() ?? '';
      if (pathSeg !== bridgeToken) {
        return { ok: false, error: 'webhookUrl token mismatch' };
      }
    } catch {
      return { ok: false, error: 'invalid webhookUrl' };
    }
  }

  // 3. 查 subscriber token → wecom_id
  const wecomId = await getWecomIdByToken(bridgeToken);
  if (!wecomId) {
    return { ok: false, error: 'unknown bridge_token' };
  }

  // 4. 内层验签（共享实现 engine-sig.ts）
  const engineSig = body.engine_sig as string | undefined;
  if (!engineSig || !/^[0-9a-f]{64}$/.test(engineSig)) {
    return { ok: false, error: 'missing or invalid engine_sig' };
  }

  // 引擎写入字段（txn_id/subscriber_id/engine_content）优先，兼容旧字段名
  const txnId = (body.txn_id as string) ?? (body.transactionId as string) ?? '';
  const subscriberId = (body.subscriber_id as string) ?? (body.subscriberId as string) ?? '';
  const content = (body.engine_content as string) ?? (body.content as string) ?? '';
  const digest = contentDigest(content);

  if (!verifyEngineSig(engineSig, txnId, subscriberId, digest, engineBridgeSecret)) {
    return { ok: false, error: 'engine_sig mismatch' };
  }

  // 5. nonce 防重放
  const nonceKey = `${bridgeToken}:${sha256Hex(rawBody)}`;
  if (nonceCache.has(nonceKey)) {
    return { ok: false, error: 'nonce replay' };
  }
  nonceCache.set(nonceKey, Date.now());

  return { ok: true, wecomId };
}
