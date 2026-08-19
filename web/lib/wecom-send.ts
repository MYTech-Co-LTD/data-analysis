/**
 * 企微消息发送共享库（web 侧副本）
 *
 * 从 functions/wecom-notify/index.js 提取，供 wecom-bridge 路由使用。
 * 与 Edge Function 版本保持接口一致，Task 15 全量切换时对齐。
 *
 * 扩展（2026-08-20）：支持多 msgtype——text / markdown / textcard / news / template_card。
 *   结构化字段经 Novu chat content 的 JSON 契约传递（bridge 解析 dispatch，见 route）。
 *
 * 所需 env：WECOM_CORP_ID / WECOM_OPS_SECRET / WECOM_OPS_AGENT_ID
 */

// ---- access_token 缓存 ----

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const corpId = process.env.WECOM_CORP_ID;
  const corpSecret = process.env.WECOM_OPS_SECRET;

  if (!corpId || !corpSecret) {
    throw new Error('WECOM_CORP_ID / WECOM_OPS_SECRET not configured');
  }

  // 缓存命中（提前 5min 过期）
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
  );
  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
  };

  return cachedToken.token;
}

// ---- 发送接口 ----

export interface SendResult {
  ok: boolean;
  errcode: number;
  errmsg: string;
  sent_to: string;
  msgtype: string;
}

/** 企微消息体（各 msgtype 专属结构由 builder 构造） */
export type WecomMessage =
  | { touser: string; msgtype: 'text'; agentid: number; text: { content: string } }
  | { touser: string; msgtype: 'markdown'; agentid: number; markdown: { content: string } }
  | { touser: string; msgtype: 'textcard'; agentid: number; textcard: { title: string; description: string; url: string; btntxt?: string } }
  | { touser: string; msgtype: 'news'; agentid: number; news: { articles: Array<{ title: string; description?: string; url: string; picurl?: string }> } }
  | { touser: string; msgtype: 'template_card'; agentid: number; template_card: Record<string, unknown> };

/**
 * 通用发送：构造企微 message/send 请求体 → 发送 → 归一化结果
 * @param message - 完整企微消息体（touser/msgtype/agentid + 类型专属字段）
 */
export async function sendWecomMessage(message: WecomMessage): Promise<SendResult> {
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${await getAccessToken()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    }
  );

  const data = await res.json();

  return {
    ok: data.errcode === 0,
    errcode: data.errcode,
    errmsg: data.errmsg || '',
    sent_to: message.touser,
    msgtype: message.msgtype,
  };
}

/** 构建 text 消息 */
export function buildWecomText(wecomId: string, content: string): WecomMessage {
  return { touser: wecomId, msgtype: 'text', agentid: Number(process.env.WECOM_OPS_AGENT_ID!), text: { content } };
}

/** 构建 markdown 消息（企微子集：`[链接](url)`/`<font color>`/引用块；content ≤2048 字节） */
export function buildWecomMarkdown(wecomId: string, content: string, title?: string): WecomMessage {
  return { touser: wecomId, msgtype: 'markdown', agentid: Number(process.env.WECOM_OPS_AGENT_ID!), markdown: { content: title ? `### ${title}\n${content}` : content } };
}

/** 构建 textcard 消息（title≤128 字节 / description≤512 字节 / url 必填） */
export function buildWecomTextcard(wecomId: string, p: { title: string; description: string; url: string; btntxt?: string }): WecomMessage {
  return { touser: wecomId, msgtype: 'textcard', agentid: Number(process.env.WECOM_OPS_AGENT_ID!), textcard: { title: p.title, description: p.description, url: p.url, btntxt: p.btntxt } };
}

/** 构建 news 图文消息（articles[]: title/description/picurl/url） */
export function buildWecomNews(wecomId: string, articles: Array<{ title: string; description?: string; url: string; picurl?: string }>): WecomMessage {
  return { touser: wecomId, msgtype: 'news', agentid: Number(process.env.WECOM_OPS_AGENT_ID!), news: { articles } };
}

/**
 * 构建 template_card 消息（文本通知型 text_notice 起步）。
 * @param p.main_title 主标题（≤128 字节）；sub_title_text 副标题；card_action.url 跳转
 */
export function buildWecomTemplateCard(wecomId: string, p: { main_title: string; sub_title_text?: string; url?: string }): WecomMessage {
  const template_card: Record<string, unknown> = {
    card_type: 'text_notice',
    main_title: { title: p.main_title },
  };
  if (p.sub_title_text) template_card.sub_title_text = p.sub_title_text;
  if (p.url) template_card.card_action = { type: 1, url: p.url };
  return { touser: wecomId, msgtype: 'template_card', agentid: Number(process.env.WECOM_OPS_AGENT_ID!), template_card };
}

// ---- 兼容旧接口：sendWecomMarkdown / sendWecomText（供既有调用方） ----

/** 发送企微 markdown 消息（向后兼容） */
export async function sendWecomMarkdown(wecomId: string, content: string, title?: string): Promise<SendResult> {
  return sendWecomMessage(buildWecomMarkdown(wecomId, content, title));
}

/** 发送企微 text 消息 */
export async function sendWecomText(wecomId: string, content: string): Promise<SendResult> {
  return sendWecomMessage(buildWecomText(wecomId, content));
}
