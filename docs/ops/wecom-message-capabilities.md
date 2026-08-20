# 企微应用消息能力参考（Novu chat-webhook → bridge 实测）

> 日期：2026-08-20 · 实测验证（生产 ZhangDuo 逐条验证）· 用途：后续推送模板设计/配置的字段与限制速查
> 链路：push 引擎渲染变量 → Novu workflow content（模板/JSON 契约）→ wecom-bridge（`web/app/api/wecom-bridge/[token]/route.ts`）→ 企微 `message/send`
> Bridge 按 content 的 JSON 契约（含 `msgtype`）dispatch 到不同消息类型；纯文本（非 JSON）走 markdown。

## 1. 平台已支持的企微消息类型（bridge 实测）

| msgtype | 用途 | 实测状态 | 关键字段 |
|---|---|---|---|
| `markdown` | 富文本日报 | ✅ 可发（链接可点） | content ≤**2048 字节**；支持 `#`/`**`/`<font color>`/`>`/`[]()`；**不支持内联图片**（`![]()` 只显示链接文本）；微工作台不支持 |
| `text` | 纯文本 | ✅ 可发 | content；text 里 URL 自动可点 |
| `textcard` | 文本卡片 | ✅ 可发（卡片可点） | title ≤128B / description ≤512B / url **必填** / btntxt |
| `news` | 图文消息 | ✅ 可发（封面图可显示） | articles ≤8 条；每条 title ≤128B / description ≤512B / url ≤**2048B** / picurl（**图片 URL**，大图建议 1068×455、小图 150×150，JPG/PNG） |
| `template_card` | 模板卡片 | ✅ 可发（多种 card_type） | card_action.url ≤**1024B**；见 §2 |

## 2. template_card `news_notice`（图文展示型）完整能力

### 2.1 字段表（全部实测）

| 字段 | 必填 | 能力 | 颜色 | 跳转 |
|---|---|---|---|---|
| `source` | 否 | 来源行（icon_url + desc） | ✅ `desc_color` 0灰/1黑/2红/3绿 | — |
| `main_title` | 是 | 主标题（title）+ 副标题（desc） | ❌ | — |
| `quote_area` | 否 | 引用块（title + quote_text） | ❌ | ✅ type=1 + url |
| `card_image` | 是 | 大图（url + aspect_ratio **1.3~2.25**，默认 1.3） | — | — |
| `image_text_area` | 否 | 左图右文（image_url + title + desc） | ❌ | ✅ type=1 + url |
| `vertical_content_list` | 否 | 垂直文字列表 ≤4（title + value） | ❌ | — |
| `horizontal_content_list` | 否 | 键值列表 ≤6（keyname + value + type + url） | ❌（**官方不支持 color**） | ✅ type=1 + url（type=3 跳成员详情） |
| `card_action` | 是 | 整卡跳转 | — | ✅ type=1 + url（type=2 小程序） |

### 2.2 实测限制（踩坑记录）

1. **`horizontal_content_list` / `vertical_content_list` 不支持 color**——传了 `color` 字段被忽略（官方文档无此字段）。颜色只支持 `source.desc_color`。曾误用导致「达成率/成本」颜色显示白色。
2. **`card_action.url` ≤1024 字节**（errcode 40058）——JWT 长 URL（1513，69 店 data_scope）超限；**news 的 url ≤2048 能放下**。短 URL 方案：直接用目标看板短链（`https://data.shanhaiyiguo.com/reports/targets`），用户企微会话自动带权限，无需 JWT。
3. **`card_image` 的 url** 是图片 URL（非 media_id）；但引入 `quote_area` + `horizontal type=2` 等组合曾触发 42029 Missing Mediaid——**用 type=1（url 跳转）规避**，type=2（引用）需要 media 相关字段，慎用。
4. **整卡可点 + 区域独立可点**：`card_action`（整卡）+ `quote_area`/`image_text_area`/`horizontal[type=1]`（各区域独立 url）——支持「整卡进看板 + 局部跳明细」多目标导航。

## 3. 平台链路（preset → Novu → bridge）

```
push_message_presets（DB 配置：msgtype + 字段模板 / card_json 完整 card）
  → 引擎 runPush 渲染变量（sale_amount 等）进 payload
  → Novu workflow content = {{{message_content}}}（triple-stash + variables 声明）
  → chat-webhook → bridge
  → bridge 解析 content：JSON 含 msgtype → dispatch（text/markdown/textcard/news/template_card）
                       疑似 JSON 却 parse 失败 → 告警日志 + markdown 降级（不静默）
  → 企微 message/send
```

⚠️ **Novu 模板三合一铁律（2026-08-20 生产两连踩后定稿）**：Novu content 模板必须写 **`{{{message_content}}}`（triple-stash、无 `payload.` 前缀）**，且变量在 workflow step 的 `template.variables` 里声明。三条各自炸过：

1. **`{{payload.X}}` 前缀恒空**——worker `getCompilePayload` 把 payload **平铺**进渲染上下文，没有 `payload.` 包装层 → 渲染空串 → bridge 400 missing content → Novu 对 4xx 不重试照标 sent（收不到、无告警）。
2. **双花括号 `{{X}}` HTML 转义**——`CompileTemplateUsecase` 用原生 Handlebars，`"`→`&quot;` → JSON 契约被破坏 → bridge parse 失败 → markdown 兜底 → **用户收到 JSON 裸文本而非卡片（链路照样 200/sent 全绿）**。修复=triple-stash `{{{X}}}`（handlebars raw 输出）。
3. **variables 漏声明**——多次 PUT 只改 content 清空 variables → 变量全渲染空。PUT 后必须复查 `template.variables`。

> 注：2026-08-20 上午曾记录「`{{payload.message_content}}` 整段转发可靠（sent+收到卡片）」——该结论已被推翻：当时 sent 是真，但「收到动态卡片」实为 markdown 兜底的 JSON 裸文本误判（status=sent 与 bridge 200 均不能证明卡片渲染成功，判真只有收件人看到的消息形态）。

**呈现层 preset 投递形态（定稿）**：Novu content 固定 `{{{message_content}}}` + variables 声明 `message_content`，呈现细节全部由 DB 侧 `push_message_presets` 决定（text/markdown 用 content_template；template_card 用 card_json 完整 card 对象，`{{var}}` 深度插值，migration 203）。

## 4. 快速选用指引

> **统一裁定（2026-08-20 用户裁定）**：推送消息**统一用 `template_card` `news_notice`**——大图 + 主副标题 + 键值列表 + 整卡跳转（card_action 短链 `/reports/targets`，企微会话自带权限，避开 1024B URL 限制）。其它类型仅作特殊场景备选。

| 需求 | 推荐类型 |
|---|---|
| **标准推送卡片（日报/告警/通知）** | `template_card` `news_notice`（**统一默认**，preset 配 card_json） |
| 纯文本 / 简单通知 | `text` 或 `markdown` |
| 富文本日报（标题/加粗/颜色/引用） | `markdown`（无图） |
| **带图消息** | `news`（picurl）或 `template_card` `news_notice`（card_image） |
| 卡片 + 多区域跳转 | `template_card` `news_notice`（card_action + 区域 url） |
| 纯图片 | `image`（需先上传媒体拿 media_id，bridge 未实现） |

## 5. 参考

- 企微发送应用消息：https://developer.work.weixin.qq.com/document/path/90236
- 模板卡片类型：https://developer.work.weixin.qq.com/document/path/101032
- 消息推送配置说明：https://developer.work.weixin.qq.com/document/path/99110
