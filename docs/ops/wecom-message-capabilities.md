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
push_message_presets（DB 配置：msgtype + 字段模板）
  → 引擎 runPush 渲染变量（detail_url 等）进 payload
  → Novu workflow content = 模板（静态或含 {{payload.X}}；模板需在 Novu 声明 variables 才会渲染）
  → chat-webhook → bridge
  → bridge 解析 content：JSON 含 msgtype → dispatch（text/markdown/textcard/news/template_card）
                       纯文本 → markdown
  → 企微 message/send
```

⚠️ **Novu 模板 variables 铁律**：Novu content 模板里的 `{{payload.X}}` 变量，**必须在 workflow step 的 `template.variables` 里声明**，否则渲染为空（实测踩坑：多次 PUT 只改 content 清空 variables → `{{payload.X}}` 全渲染空 → bridge 400 missing content）。

⚠️ **不要用 `{{payload.message_content}}` 转发整段**：曾用「引擎渲染 message_content → Novu content = `{{payload.message_content}}`」方案，Novu 渲染该值不稳定（空）。正确做法：Novu content 直接用变量模板（`{{payload.detail_url}}` 等），或静态 JSON 契约。

## 4. 快速选用指引

| 需求 | 推荐类型 |
|---|---|
| 纯文本 / 简单通知 | `text` 或 `markdown` |
| 富文本日报（标题/加粗/颜色/引用） | `markdown`（无图） |
| **带图消息** | `news`（picurl）或 `template_card` `news_notice`（card_image） |
| 卡片 + 多区域跳转 | `template_card` `news_notice`（card_action + 区域 url） |
| 纯图片 | `image`（需先上传媒体拿 media_id，bridge 未实现） |

## 5. 参考

- 企微发送应用消息：https://developer.work.weixin.qq.com/document/path/90236
- 模板卡片类型：https://developer.work.weixin.qq.com/document/path/101032
- 消息推送配置说明：https://developer.work.weixin.qq.com/document/path/99110
