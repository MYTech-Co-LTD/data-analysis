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
import {
  sendWecomMarkdown,
  sendWecomText,
  sendWecomMessage,
  buildWecomTextcard,
  buildWecomNews,
  buildWecomTemplateCard,
  type SendResult,
} from '@/lib/wecom-send';

/**
 * 结构化 dispatch（2026-08-20 扩展）：Novu chat content 若为 JSON 契约（含 msgtype），
 *   按类型构造对应企微消息体（text/markdown/textcard/news/template_card）；
 *   否则按 markdown 发送（向后兼容）。
 */
async function dispatchWecom(wecomId: string, structured: Record<string, unknown>): Promise<SendResult> {
  const msgtype = String(structured.msgtype);
  switch (msgtype) {
    case 'text':
      return sendWecomText(wecomId, String(structured.content ?? ''));
    case 'markdown':
      return sendWecomMarkdown(wecomId, String(structured.content ?? ''), structured.title ? String(structured.title) : undefined);
    case 'textcard':
      return sendWecomMessage(buildWecomTextcard(wecomId, {
        title: String(structured.title ?? ''),
        description: String(structured.description ?? ''),
        url: String(structured.url ?? ''),
        btntxt: structured.btntxt ? String(structured.btntxt) : undefined,
      }));
    case 'news':
      return sendWecomMessage(buildWecomNews(wecomId, Array.isArray(structured.articles) ? structured.articles as Array<{ title: string; description?: string; url: string; picurl?: string }> : []));
    case 'template_card':
      // 2026-08-20：透传原始 template_card 对象（支持 news_notice 带 card_image 等所有 card_type），
      //   兼容简写 main_title/url（text_notice 便捷形态）
      return sendWecomMessage(buildWecomTemplateCard(wecomId, {
        ...(typeof structured.template_card === 'object' && structured.template_card !== null
          ? (structured.template_card as Record<string, unknown>)
          : {}),
        ...(structured.main_title ? { main_title: { title: String(structured.main_title) } } : {}),
        ...(structured.url ? { url: String(structured.url) } : {}),
      }));
    default:
      // 未知 msgtype → 回退 markdown（原样序列化，避免丢内容）
      return sendWecomMarkdown(wecomId, JSON.stringify(structured));
  }
}

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

  // 5. 发送企微消息：content 为 JSON 契约（含 msgtype）→ 结构化 dispatch；否则 markdown（向后兼容）
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 非 JSON（普通 markdown/text）→ 走 markdown
  }

  let sendResult: SendResult;
  try {
    sendResult =
      parsed && typeof parsed === 'object' && typeof parsed.msgtype === 'string'
        ? await dispatchWecom(result.wecomId!, parsed)
        : await sendWecomMarkdown(result.wecomId!, content);
  } catch (err) {
    console.error('[wecom-bridge] send error', err);
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 }
    );
  }

  if (!sendResult.ok) {
    // 企微 60020 等错误：返非 2xx 让 Novu 重试
    console.error('[wecom-bridge] send failed', sendResult);
    return NextResponse.json(
      { error: 'wecom_send_failed', detail: sendResult },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, sent_to: result.wecomId });
}
