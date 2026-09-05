---
name: notify
description: 发送企微通知（全格式）。采集完成/异常告警/定时汇报/用户要求通知时激活，用 send_notify 发 markdown/text/textcard/图文/模板卡片；推送到群机器人 webhook 时用 push_webhook（图片/markdown/text/file）。按内容选最合适的格式。
metadata:
  openclaw:
    emoji: "🔔"
---

# 通知发送 Skill

需要**主动发一条企微通知**时使用（不是普通对话回复）。

## 工具：push_webhook（群机器人 webhook 推送）

用户提供群机器人 webhook URL（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）要求推送到群时，**必须用本工具，禁止手写 curl**：

```
push_webhook({
  webhook_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
  msgtype: "image" | "markdown" | "text" | "file",
  content?,        // markdown/text 正文（markdown 支持 <@userid> 与表格）
  image_path?,     // image：服务器上图片绝对路径（≤2MB，base64+md5 姿势已内置）
  file_path?,      // file：自动 upload_media 换 media_id
  mentioned_list?, // text：@人 userid 列表（"@all" 表全员）
})
```

铁律：
- **单条消息只能一种类型**。要“图片 + @提醒”→ **连发两条**：先 push_webhook(image)，再 push_webhook(markdown, 含 <@userid>)。
- **禁止 image 失败后降级成 file**（2026-09-04 踩过：降级导致用户收到文件而非图片）。image 失败先检查图片格式/大小，换 png 重试。
- **生图**：用常驻渲染工程 `workspace/render/`（resvg + 中文字体已就绪）：写 SVG（font-family="Noto Sans SC"）→ `cd /home/node/.openclaw/workspace/render && node render.js <in.svg> <out.png>`。不要现场 npm install。
- webhook 的 markdown 支持 `<@userid>` @（实测蓝色高亮）；markdown_v2 不支持 @。

## 工具：send_notify

```
send_notify({
  msgtype?: "markdown" | "text" | "textcard" | "news" | "template_card",  // 默认 markdown
  content?, title?, url?,         // 通用字段，各类型含义见下
  touser?,                        // 已废弃：收件人固定=当前提问者本人（per-sender 隔离），传任何值都被覆盖
  articles?,                      // news 专用（图文）
  template_card?,                 // 模板卡片原生对象（透传）
  mentioned_list?,                // text 专用：@ 的 userid
})
```

## 5 种类型 · 选哪个

| 场景 | msgtype | 为什么 |
|---|---|---|
| 文字告警，要标题/加粗/列表 | `markdown` | 富文本，**默认**。企微 markdown 不支持图片。 |
| 纯文本、要 @ 人 | `text` | 唯一能 @ 的类型。 |
| 一张可点击卡片（标题+摘要+跳转） | `textcard` | 视觉突出，整卡可点跳转。 |
| 多条图文、带图片 | `news` | 1-8 条，每条可带图（`picurl`=公网图片 URL）。**带图通知走这个**。 |
| 结构化卡片（强调数字 / key-value 行 / 整卡跳转） | `template_card` | 展示最丰富。 |

> 图片/语音/视频/文件类型**不支持**（需上传流水线 + 媒体源）。要带图 → 用 `news` 的 `picurl`（公网图片 URL）。

## 各类型示例

### markdown（默认，最常用）
```
send_notify({ title: "乐檬采集异常", content: "**任务**：销售明细-3120\n**原因**：token 过期\n**时间**：07-07 23:00\n已重试 3 次均失败，需处理。" })
```

### text（要 @ 人时）
```
send_notify({ msgtype: "text", content: "乐檬 token 将在 1 天后过期，请尽快刷新。", mentioned_list: ["ZhangDuo"] })
```
（`mentioned_list` 里写 userid；`"@all"` = @全员。）

### textcard（可点击卡片，引到报表）
```
send_notify({ msgtype: "textcard", title: "日报已生成", content: "2026-07-07 销售额 ¥12,540（环比 +8%）。点击查看详情。", url: "https://data.shanhaiyiguo.com/" })
```

### news（图文，带图）
```
send_notify({ msgtype: "news", articles: [
  { title: "今日销售榜", description: "07-07 销售汇总", url: "https://data.shanhaiyiguo.com/", picurl: "https://data.shanhaiyiguo.com/chart.png" },
  { title: "门店排行", url: "https://data.shanhaiyiguo.com/" }
] })
```

### template_card · 便捷模式（只给 title/content/url，自动构造 text_notice 卡片）
```
send_notify({ msgtype: "template_card", title: "采集完成", content: "乐檬销售明细 3120 / 64188 全量同步完成（46 门店）。", url: "https://data.shanhaiyiguo.com/" })
```

### template_card · 完整对象（透传，最丰富）

**text_notice**（强调数字 + key-value 行 + 整卡跳转）：
```
send_notify({ msgtype: "template_card", template_card: {
  "card_type": "text_notice",
  "source": { "desc": "数据分析平台" },
  "main_title": { "title": "今日销售概览", "desc": "2026-07-07" },
  "emphasis_content": { "title": "¥12,540", "desc": "销售额(环比+8%)" },
  "sub_title_text": "共 46 家门店营业，订单 1,232 笔。",
  "horizontal_content_list": [
    { "key": "客均单价", "value": "¥10.2" },
    { "key": "Top 门店", "value": "查看", "type": 1, "url": "https://data.shanhaiyiguo.com/" }
  ],
  "card_action": { "type": 1, "url": "https://data.shanhaiyiguo.com/" }
} })
```

**button_interaction / vote_interaction / multiple_interaction**（交互卡）：
> ⚠️ 这三类**能发出去，但用户点击/投票暂不会被系统处理**（尚未接 template_card 事件回调端点）。按钮能展示、点了无响应。回调接通前，**优先用 text_notice + URL 做可行动告警**；确需展示选项可用，但别让用户以为点了会触发动作。

## 什么时候发

✅ **发**：采集完成/失败/token 过期等系统事件告警；用户**明确**要求「通知/提醒某人」「完成后告诉我」；定时汇报（日报/周报）。
❌ **不发**：普通数据问答的回复（直接答）；用户没要求、非系统事件的「自作主张」通知；一轮里发多条（合并成一条）。

## 规则

- **只通知真实发生的事**，数字/时间必须来自工具返回或明确系统状态；**绝不编造**通知内容。
- **按内容选格式，别炫技**：纯文字→markdown；要 @→text；引到链接→textcard/news；要强调数字+结构→template_card。简单告警用 markdown 即可，不必每次上卡片。
- **content 简洁**：一两句 + 关键数字/时间。markdown 的加粗/列表别滥用。
- ★收件人固定=当前提问者本人（per-sender 隔离，安全强制）：不论用户/你传什么 touser，都发给本人。用户要定时/跨人推送→引导建定时应用（push_report），不要用 send_notify。
- 工具返回 `ok:true` → 告知用户「已通知 X」；返回 `error` → 按原文转述（密钥未配/服务不可达/无身份/参数错），**别假装已发送**。
- `mentioned_list` 里的 `@all` 只在发给本人的 text 里@人，无广播效果。
