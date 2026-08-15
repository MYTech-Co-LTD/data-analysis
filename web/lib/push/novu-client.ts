/**
 * Novu 客户端封装
 *
 * 契约来源：spec §5.3
 * - subscriber upsert（含 push_subscriber_tokens 同步）
 * - triggerBulk（≤100 分批）
 * - engine_sig 内层签名（防伪冒）
 */

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
 * 生成 engine_sig 内层签名
 *
 * HMAC-SHA256(txnId + subscriberId + contentDigest, ENGINE_BRIDGE_SECRET)
 * 用于 wecom-bridge 验证内容真实性
 */
export async function generateEngineSig(
  txnId: string,
  subscriberId: string,
  contentDigest: string
): Promise<string> {
  const { engineSecret } = getNovuConfig();
  if (!engineSecret) throw new Error('ENGINE_BRIDGE_SECRET not set');

  const crypto = await import('crypto');
  return crypto
    .createHmac('sha256', engineSecret)
    .update(`${txnId}:${subscriberId}:${contentDigest}`)
    .digest('hex');
}

/**
 * 生成内容摘要（SHA256 前 16 位）
 */
export async function contentDigest(content: string): Promise<string> {
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 触发 Novu bulk 消息
 *
 * - 每批 ≤100 人
 * - payload 含 engine_sig（内层签名）
 * - 返回所有批次结果
 */
export async function triggerBulk(
  workflowId: string,
  subscribers: Array<{ subscriberId: string; payload: Record<string, unknown> }>,
  overrides?: Record<string, unknown>
): Promise<{ total: number; batches: number; errors: string[] }> {
  const { apiUrl, apiKey } = getNovuConfig();
  if (!apiUrl || !apiKey) throw new Error('Novu API config missing');

  const BATCH_SIZE = 100;
  const errors: string[] = [];
  let batches = 0;

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);

    // 为每个 subscriber 注入 engine_sig
    const toWithSig = await Promise.all(
      batch.map(async (s) => {
        const digest = await contentDigest(JSON.stringify(s.payload));
        const sig = await generateEngineSig(workflowId, s.subscriberId, digest);
        return {
          subscriberId: s.subscriberId,
          payload: { ...s.payload, engine_sig: sig },
        };
      })
    );

    const body: NovuBulkTrigger = {
      name: workflowId,
      to: toWithSig.map((s) => ({ subscriberId: s.subscriberId })),
      payload: toWithSig[0]?.payload || {},
      overrides,
    };

    // Novu trigger API
    const resp = await fetch(`${apiUrl}/v1/events/trigger/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({ events: [body] }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      errors.push(`batch ${batches}: ${resp.status} ${text}`);
    }
    batches++;
  }

  return { total: subscribers.length, batches, errors };
}
