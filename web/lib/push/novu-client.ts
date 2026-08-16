/**
 * Novu 客户端封装
 *
 * 契约来源：spec §5.3
 * - subscriber upsert（含 push_subscriber_tokens 同步）
 * - triggerBulk（≤100 分批，event 级 transactionId + engine_sig 内层签名）
 *
 * engine_sig 契约见 ./engine-sig.ts（与 bridge-verify 共享实现，Review B5 修复）。
 * 每个 event：
 *   - transactionId = txnId（Novu 原生事件级字段）
 *   - payload 内含 engine_sig / engine_content / txn_id / subscriber_id，
 *     供 Novu workflow 的 chat-webhook step 透传进送达 body（bridge 依此验签）。
 */

import { randomBytes } from 'crypto';
import { contentDigest, generateEngineSig } from './engine-sig';

// 兼容既有引用/测试 mock 形状（run-push 测试 vi.mock('../novu-client') 依赖这些导出名）
export { contentDigest, generateEngineSig };

// 运行时读取（兼容测试注入）
function getNovuConfig() {
  return {
    apiUrl: process.env.NOVU_API_URL || '',
    apiKey: process.env.NOVU_API_KEY || '',
    bridgeSecret: process.env.NOVU_BRIDGE_SECRET || '',
    engineSecret: process.env.ENGINE_BRIDGE_SECRET || '',
  };
}

export interface NovuSubscriber {
  subscriberId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  // 自定义数据（如 wecom_id, bridge_token）
  data?: Record<string, unknown>;
}

export interface NovuBulkTrigger {
  name: string; // workflowId
  to: Array<{ subscriberId: string }>;
  payload: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

/**
 * Upsert Novu subscriber
 *
 * 同步 bridge_token → push_subscriber_tokens（PostgREST）
 */
export async function upsertSubscriber(
  subscriber: NovuSubscriber,
  bridgeToken?: string
): Promise<{ subscriberId: string }> {
  const { apiUrl, apiKey } = getNovuConfig();
  if (!apiUrl || !apiKey) throw new Error('Novu API config missing');

  const resp = await fetch(`${apiUrl}/v1/subscribers`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(subscriber),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Novu upsert subscriber failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();

  // 同步 bridge_token → push_subscriber_tokens
  if (bridgeToken && subscriber.data?.wecom_id) {
    await syncBridgeToken(bridgeToken, subscriber.data.wecom_id as string);
  }

  return { subscriberId: data.data?.subscriberId || subscriber.subscriberId };
}

/**
 * 同步 bridge_token 到 PostgREST push_subscriber_tokens
 */
async function syncBridgeToken(bridgeToken: string, wecomId: string): Promise<void> {
  const postgrestUrl = process.env.POSTGREST_URL;
  const postgrestKey = process.env.POSTGREST_ANON_KEY;
  if (!postgrestUrl || !postgrestKey) return;

  await fetch(`${postgrestUrl}/push_subscriber_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${postgrestKey}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      bridge_token: bridgeToken,
      wecom_id: wecomId,
    }),
  }).catch(() => {
    // best-effort，不阻断主流程
  });
}

/**
 * 生成 Novu subscriber 的 bridge_token（缺失时新建）
 * - 32B 高熵 hex（64 字符），作为 Novu webhookUrl 路径段
 */
export function newBridgeToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * 触发 Novu bulk 消息
 *
 * - 每批 ≤100 人
 * - 每个 event 带 transactionId = txnId（Novu 原生事件级字段）
 * - payload 含 engine_sig / engine_content / txn_id / subscriber_id（bridge 验签依据）
 * - 返回批量结果 + 失败批次内的 subscriberId（供 fallback 只补失败者，Review M8 修复）
 */
export async function triggerBulk(
  workflowId: string,
  subscribers: Array<{ subscriberId: string; payload: Record<string, unknown> }>,
  txnId?: string,
  overrides?: Record<string, unknown>
): Promise<{ total: number; batches: number; errors: string[]; failedSubscribers: string[] }> {
  const { apiUrl, apiKey } = getNovuConfig();
  if (!apiUrl || !apiKey) throw new Error('Novu API config missing');

  const BATCH_SIZE = 100;
  const errors: string[] = [];
  const failedSubscribers: string[] = [];
  let batches = 0;

  // 为每个 subscriber 生成独立 engine_sig + 独立 event
  const eventTxnId = txnId ?? workflowId;
  const allEvents = subscribers.map((s) => {
    // 规范内容串：签名与 bridge 验证共用同一字节序列
    const engineContent = JSON.stringify({ subscriberId: s.subscriberId, payload: s.payload });
    const digest = contentDigest(engineContent);
    const sig = generateEngineSig(eventTxnId, s.subscriberId, digest);
    return {
      name: workflowId,
      to: [{ subscriberId: s.subscriberId }],
      transactionId: eventTxnId,
      payload: {
        ...s.payload,
        engine_sig: sig,
        engine_content: engineContent,
        txn_id: eventTxnId,
        subscriber_id: s.subscriberId,
      },
      ...(overrides ? { overrides } : {}),
    };
  });

  // 按 BATCH_SIZE 分批 POST（每批 events 数组内每人独立 payload）
  for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
    const batch = allEvents.slice(i, i + BATCH_SIZE);

    const resp = await fetch(`${apiUrl}/v1/events/trigger/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({ events: batch }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      errors.push(`batch ${batches}: ${resp.status} ${text}`);
      for (const ev of batch) failedSubscribers.push(ev.to[0].subscriberId);
    }
    batches++;
  }

  return { total: subscribers.length, batches, errors, failedSubscribers };
}
