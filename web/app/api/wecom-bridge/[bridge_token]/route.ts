/**
 * wecom-bridge 路由
 *
 * Novu chat-webhook → 本路由 → 企微 message/send
 * 双层验签：X-Novu-Signature + engine_sig
 *
 * 契约来源：docs/ops/novu-bridge-signature-verification.md（V1 快照）
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyBridge } from '@/lib/push/bridge-verify';
import { sendWecomMarkdown } from '@/lib/wecom-send';

// ---- PostgREST 客户端（查 push_subscriber_tokens） ----

function getPostgrestHeaders(): Record<string, string> {
  const key = process.env.INSFORGE_API_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' };
}

function getPostgrestUrl(): string {
  return process.env.POSTGREST_URL || 'http://localhost:3000';
}

// ---- 路由处理 ----

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ bridge_token: string }> }
) {
  const { bridge_token: bridgeToken } = await params;

  // 1. 读取 raw body
  const rawBody = await req.arrayBuffer();
  const rawBodyBuffer = Buffer.from(rawBody);

  // 2. 提取 headers
  const headers: Record<string, string | undefined> = {
    'x-novu-signature': req.headers.get('x-novu-signature') || undefined,
  };

  // 3. 验签
  const pgUrl = getPostgrestUrl();
  const pgHeaders = getPostgrestHeaders();
  const result = await verifyBridge({
    bridgeToken,
    rawBody: rawBodyBuffer,
    headers,
    getWecomIdByToken: async (token: string) => {
      const resp = await fetch(`${pgUrl}/push_subscriber_tokens?bridge_token=eq.${encodeURIComponent(token)}&select=wecom_id&limit=1`, { headers: pgHeaders });
      const rows = await resp.json();
      return Array.isArray(rows) && rows.length > 0 ? rows[0].wecom_id : null;
    },
  });

  if (!result.ok) {
    // 401 不区分原因（安全最佳实践）
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 4. 解析 body 取 content
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBodyBuffer.toString('utf-8'));
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const content = body.content as string;
  if (!content || typeof content !== 'string') {
    return NextResponse.json({ error: 'missing content' }, { status: 400 });
  }

  // 5. 发送企微消息
  try {
    const sendResult = await sendWecomMarkdown(result.wecomId!, content);

    if (!sendResult.ok) {
      // 企微 60020 等错误：返非 2xx 让 Novu 重试
      console.error('[wecom-bridge] send failed', sendResult);
      return NextResponse.json(
        { error: 'wecom_send_failed', detail: sendResult },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, sent_to: result.wecomId });
  } catch (err) {
    console.error('[wecom-bridge] send error', err);
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 }
    );
  }
}
