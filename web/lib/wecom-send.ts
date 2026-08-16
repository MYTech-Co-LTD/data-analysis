/**
 * 企微消息发送共享库（web 侧副本）
 *
 * 从 functions/wecom-notify/index.js 提取，供 wecom-bridge 路由使用。
 * 与 Edge Function 版本保持接口一致，Task 15 全量切换时对齐。
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

/**
 * 发送企微 markdown 消息
 * @param wecomId - 企微 userid
 * @param content - markdown 内容（企微子集）
 * @param title - 可选标题
 */
export async function sendWecomMarkdown(
  wecomId: string,
  content: string,
  title?: string
): Promise<SendResult> {
  const agentId = process.env.WECOM_OPS_AGENT_ID;
  if (!agentId) {
    throw new Error('WECOM_OPS_AGENT_ID not configured');
  }

  const accessToken = await getAccessToken();

  const message = {
    touser: wecomId,
    msgtype: 'markdown',
    agentid: Number(agentId),
    markdown: {
      content: title ? `### ${title}\n${content}` : content,
    },
  };

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
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
    sent_to: wecomId,
    msgtype: 'markdown',
  };
}
