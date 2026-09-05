// openclaw/notify-plugin/index.js
// 统一通知工具（架构文档 §7.1.1）：OpenClaw 主动发企微通知时调用，
// 转发到 wecom-notify function（App B / Agent 1000009 发送）。
//
// 支持企微应用消息全部常用类型：markdown / text(可@) / textcard / news(图文) / template_card(模板卡片)。
// 注册形式对齐 data-query 插件：api.registerTool(factory, { name })。
// - name 放第二参数 metadata（运行时注册 + 模型发现都靠它；放 factory 返回里会被判 malformed）。
// - factory 每轮调用，从 ctx.requesterSenderId 取可信企微 userid（核心注入，非 LLM 传），
//   用于解析 "@sender" 收件人。execute 闭包捕获当轮 senderId。
// - AGENT_API_KEY 留 openclaw 容器 env（compose 注入，同 data-query），不进 LLM/用户上下文。
// - NOTIFY_URL 默认 http://insforge:7130/functions/wecom-notify（与 agent-query 同 host）。
//
// 依赖：仅 openclaw 运行时（definePluginEntry 由 loader 解析）。无 typebox 等 npm 依赖。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import path from "node:path";

const NOTIFY_URL =
  process.env.NOTIFY_URL || "http://insforge:7130/functions/wecom-notify";

const TOOL_NAME = "send_notify";
const TOOL_DESC =
  "向企业微信发送一条通知消息（系统统一通知服务 App B 发送）。支持全量应用消息格式：" +
  "markdown / text(可@人) / textcard(可点击卡片) / news(图文，可带图) / template_card(模板卡片，含交互子类型)。" +
  "用于采集完成/异常告警/定时汇报/用户要求通知某人等主动通知场景；普通对话回复不要用此工具。" +
  "★收件人固定=当前提问者本人（per-sender 隔离）：传其他 touser 会被强制改回本人；跨人/定时推送走定时应用（push_report）。";
const TOOL_PARAMS = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description:
        "消息正文。markdown=markdown 正文；text=纯文本；textcard=描述；template_card(便捷模式)=sub_title_text。news 和「透传 template_card 对象」时不需。",
    },
    title: {
      type: "string",
      description:
        "标题。markdown=三级标题；textcard.title；template_card(便捷)=main_title.title。可选。",
    },
    msgtype: {
      type: "string",
      enum: ["markdown", "text", "textcard", "news", "template_card"],
      description:
        "消息类型，默认 markdown。text=纯文本可@；markdown=富文本；textcard=单张可点击卡片；news=多图文(带图)；template_card=模板卡片(结构化/交互)。选型见 notify skill。",
    },
    touser: {
      type: "string",
      description:
        "已废弃（保留兼容）：收件人固定为当前提问者本人（per-sender 隔离），传任何值都会被覆盖。",
    },
    url: {
      type: "string",
      description:
        "跳转链接。textcard 的 url；template_card(便捷模式)的 card_action.url。",
    },
    articles: {
      type: "array",
      description:
        "news 专用：图文数组，1-8 条。每条 {title, url, description?, picurl?}。picurl=公网图片 URL（带图通知走此，无需上传）。",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          url: { type: "string" },
          picurl: { type: "string" },
        },
      },
    },
    template_card: {
      type: "object",
      description:
        "模板卡片完整对象（企微原生结构），原样透传。支持 card_type: text_notice / news_notice / button_interaction / vote_interaction / multiple_interaction。结构示例见 notify skill。传此对象时 content/title/url 忽略。",
    },
    mentioned_list: {
      type: "array",
      items: { type: "string" },
      description: "text 专用：要 @ 的 userid 列表（'@all'=@全员）。",
    },
    mentioned_mobile_list: {
      type: "array",
      items: { type: "string" },
      description: "text 专用：要 @ 的手机号列表。",
    },
  },
  additionalProperties: false,
};

async function sendNotify(args, senderId) {
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!agentApiKey) {
    return {
      error:
        "通知服务密钥未配置（openclaw 容器缺 AGENT_API_KEY env），请联系管理员。",
    };
  }
  // C4: cron turn（senderId 空）禁 send_notify——@sender 解析不了 + 默认推 NOTIFY_DEFAULT_TUSERS 会与 push_report 重复推送。强制定时场景用 push_report（收件人从绑定取）。
  if (!senderId) {
    return {
      error:
        "cron turn 无 requesterSenderId，禁用 send_notify（@sender 解析不了、默认推会与 push_report 重复）。定时推送请用 push_report（收件人自动从绑定取）。",
    };
  }

  // ★ per-sender 隔离（用户裁定 2026-08-20）：对话场景收件人强制 = 当前提问者。
  // 不论 args.touser 传什么（具体 userid / @all / 省略），一律覆盖为 senderId——
  // 防模型被诱导把当前用户有权看的数据（含成本）推给他人/全员（数据未越权但越过「人」）。
  // 跨人/定时推送走 push_report（收件人从 scheduled_reports 绑定钉死=创建者）。
  const to = senderId;
  const overridden = args.touser && args.touser !== "@sender" && args.touser !== senderId;

  // 转发到 wecom-notify；undefined 字段不会进 JSON
  const payload = {
    agent_api_key: agentApiKey,
    content: args.content,
    title: args.title,
    touser: to,
    msgtype: args.msgtype,
    url: args.url,
    articles: args.articles,
    template_card: args.template_card,
    mentioned_list: args.mentioned_list,
    mentioned_mobile_list: args.mentioned_mobile_list,
  };

  let resp;
  try {
    resp = await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { error: "通知服务不可达：" + ((e && e.message) || String(e)) };
  }

  let body = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }

  if (!resp.ok || body.ok !== true) {
    return {
      error: body.error || "通知服务返回 HTTP " + resp.status,
      errcode: body.errcode,
      errmsg: body.errmsg,
    };
  }
  return {
    ok: true,
    sent_to: body.sent_to,
    msgtype: body.msgtype,
    ...(overridden
      ? { note: "收件人已按 per-sender 隔离强制改为提问者本人（原 touser=" + args.touser + " 被忽略）。需要定时/跨人推送请用定时应用（push_report）。" }
      : {}),
  };
}

export default definePluginEntry({
  id: "notify",
  name: "Notify",
  description:
    "统一通知出口：OpenClaw 主动发企微通知时调用（支持 markdown/text/textcard/news/template_card），转发到 wecom-notify function（App B 发送）。",
  register(api) {
    api.registerTool(
      (ctx) => {
        const senderId = ctx && ctx.requesterSenderId;
        // 首次调用打一行诊断（确认 sender 注入路径，同 data-query）。
        if (!globalThis.__NOTIFY_DIAG) {
          globalThis.__NOTIFY_DIAG = 1;
          // eslint-disable-next-line no-console
          console.log(
            "[notify] diag ctxKeys=" +
              (ctx ? Object.keys(ctx).join(",") : "none") +
              " senderId=" +
              (senderId || "<empty>") +
              " notifyUrl=" +
              NOTIFY_URL,
          );
        }
        return {
          name: TOOL_NAME,
          description: TOOL_DESC,
          parameters: TOOL_PARAMS,
          // execute 签名实测定稿（同 data-query，agent-tools.before-tool-call.js:1510）：
          //   execute(toolCallId, params, signal, onUpdate)
          // 第一个参数是 toolCallId（字符串"id"），第二个才是模型传的参数对象。
          // 这里兼容 params 为对象 / JSON 字符串 / 包一层 input|arguments|parameters。
          execute: (toolCallId, params, _signal, _onUpdate) => {
            let raw = params;
            if (typeof raw === "string") {
              try {
                raw = JSON.parse(raw);
              } catch {
                raw = { content: raw };
              }
            }
            const obj = raw && typeof raw === "object" ? raw : {};
            const pick = (k) =>
              obj[k] ??
              (obj.input && obj.input[k]) ??
              (obj.arguments && obj.arguments[k]) ??
              (obj.parameters && obj.parameters[k]);
            return sendNotify(
              {
                content: pick("content"),
                title: pick("title"),
                touser: pick("touser"),
                msgtype: pick("msgtype"),
                url: pick("url"),
                articles: pick("articles"),
                template_card: pick("template_card"),
                mentioned_list: pick("mentioned_list"),
                mentioned_mobile_list: pick("mentioned_mobile_list"),
              },
              senderId,
            );
          },
        };
      },
      { name: TOOL_NAME },
    );

    // push_webhook：群机器人 webhook 推送（姿势固化在代码里，模型不用猜）。
    // 背景（2026-09-04）：agent 手写 curl 推图到群机器人 webhook 报 invalid media type
    // 后自行降级为 file 文件，用户看到的是文件而非图片。本工具把正确姿势封死：
    //   image = base64+md5 直传（实测 errcode 0）；file = webhook/upload_media 取 media_id；
    //   markdown/text 支持 <@userid> 与 mentioned_list。禁止再手写 curl 推 webhook。
    api.registerTool(
      (_ctx) => {
        return {
          name: "push_webhook",
          description:
            "向企业微信群机器人 webhook 推送一条消息（图片/markdown/文本/文件）。" +
            "用户提供 webhook URL（形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）要求推送到群时使用。" +
            "★姿势已固化：image 自动 base64+md5 直传（不要自己 curl，手写易报 invalid media type）；" +
            "file 自动 upload_media 换 media_id；markdown/text 内容里可用 <@userid> @人。" +
            "注意：单条消息只能一种类型——要“图片+@提醒”请连发两条（本工具调两次）。",
          parameters: {
            type: "object",
            properties: {
              webhook_url: { type: "string", description: "群机器人 webhook 完整 URL（含 key= 参数）" },
              msgtype: { type: "string", enum: ["image", "markdown", "text", "file"], description: "消息类型" },
              content: { type: "string", description: "markdown/text 的正文（markdown 支持 <@userid> 与表格）" },
              image_path: { type: "string", description: "msgtype=image 时：服务器上图片文件的绝对路径（png/jpg，≤2MB）" },
              file_path: { type: "string", description: "msgtype=file 时：服务器上文件的绝对路径（≤20MB）" },
              mentioned_list: { type: "array", items: { type: "string" }, description: "msgtype=text 时：@人的 userid 列表（\"@all\" 表全员）" },
            },
            required: ["webhook_url", "msgtype"],
            additionalProperties: false,
          },
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : params || {};
            const pick = (k) =>
              obj[k] ?? (obj.input && obj.input[k]) ?? (obj.arguments && obj.arguments[k]) ?? (obj.parameters && obj.parameters[k]);
            const hookUrl = String(pick("webhook_url") || "");
            const msgtype = String(pick("msgtype") || "");
            if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?/.test(hookUrl)) {
              return { error: "webhook_url 必须是企微群机器人 webhook（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）" };
            }
            let body;
            try {
              if (msgtype === "image") {
                const p = String(pick("image_path") || "");
                if (!p || !fs.existsSync(p)) return { error: "image_path 不存在：" + p };
                const buf = fs.readFileSync(p);
                if (buf.length > 2 * 1024 * 1024) return { error: "图片超过 2MB（群机器人 image 上限），请压缩后重试" };
                body = { msgtype: "image", image: { base64: buf.toString("base64") } };
                const { createHash } = await import("node:crypto");
                body.image.md5 = createHash("md5").update(buf).digest("hex");
              } else if (msgtype === "file") {
                const p = String(pick("file_path") || "");
                if (!p || !fs.existsSync(p)) return { error: "file_path 不存在：" + p };
                const key = new URL(hookUrl).searchParams.get("key");
                const upUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${key}&type=file`;
                const fd = new FormData();
                fd.append("media", new Blob([fs.readFileSync(p)]), path.basename(p));
                const up = await (await fetch(upUrl, { method: "POST", body: fd })).json();
                if (up.errcode !== 0 || !up.media_id) return { error: "upload_media 失败", detail: up };
                body = { msgtype: "file", file: { media_id: up.media_id } };
              } else if (msgtype === "markdown") {
                const content = String(pick("content") || "");
                if (!content) return { error: "markdown 需要 content" };
                body = { msgtype: "markdown", markdown: { content } };
              } else if (msgtype === "text") {
                const content = String(pick("content") || "");
                if (!content) return { error: "text 需要 content" };
                const ml = pick("mentioned_list");
                body = { msgtype: "text", text: { content, ...(Array.isArray(ml) && ml.length ? { mentioned_list: ml.map(String) } : {}) } };
              } else {
                return { error: "msgtype 必须是 image|markdown|text|file" };
              }
            } catch (e) {
              return { error: "构造消息失败：" + String(e).slice(0, 200) };
            }
            try {
              const res = await (await fetch(hookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              })).json();
              return { ok: res.errcode === 0, errcode: res.errcode, errmsg: res.errmsg, msgtype };
            } catch (e) {
              return { error: "推送失败：" + String(e).slice(0, 200) };
            }
          },
        };
      },
      { name: "push_webhook" },
    );
  },
});
