# 报表数据横幅（report_banner）设计

> 日期：2026-08-21 · 状态：已确认 · 上游架构：docs/architecture.md §7.4 横幅渲染（2026-08-21 版）
> 演进：方案 C（2026-08-20，签名 URL 直传值）→ 本设计（值不落 URL，推送时预渲染 + 对象存储读回）

## 1. 背景与目标

方案 C 横幅（单指标「销售达成」）已上线，但只展示销售额 + 达成率两个数值。用户要求横幅内容升级为**报表中心目标看板第一页数据**，保留页面样式（类截图）：

1. **KPI 卡片**——目标总达成 4 指标：销售额（sale_amount）、配送额（delivery_amount）、出库额（outbound_amt）、出库毛利（outbound_profit）
2. **品牌指标**——3120 熊喵 / 64188 品品甜 / 合计 3 行
3. **门店战区表**——东/南/西/中 4 战区，每战区一行展示其指标数值

已裁定（2026-08-20 两轮澄清）：
- 战区表 = `report_region_breakdown_gen` 的 **region 级**（4 战区），**不是**门店下钻——每行是一个战区
- 样式为参考，**不必一比一复刻**报表页（深层简化已豁免）
- 图片写入**对象存储**，用**独立文件夹前缀**方便管理
- 图片可作为**变量**在自定义推送模板中配置（不是硬编码进 preset）

**核心约束（2026-08-20 实测）**：品牌/战区中文名经 URL 编码后超 2000 字节，超出 template_card `card_action.url` 1024B 限制 → **值不能落 URL**。方案 C「签名 URL 直传值」不可沿用，改为引擎**推送时预渲染** PNG → 写对象存储 → URL 只带短 id + 签名。

## 2. 架构总览

```
推送触发
  → run_push 引擎（web/lib/push/index.ts）逐组渲染：
      selector → scope 签名分组 → 组代签 JWT（≤10min，RLS 按 scope 裁剪）
      → 模板引用 {{report_banner}} ?
          ├─ 否 → 跳过（不写对象存储，零开销）
          └─ 是 → 引擎报表横幅模块（web/lib/push/banner-report/）：
                  ① 组代签 JWT 查 3 语义视图（与报表页同 getter、同口径、同 scope 裁剪）
                  ② 拼 SVG（1080×480，aspect 2.25，@font-face 内嵌 Noto SC 子集扩展）
                  ③ sharp 渲染 PNG
                  ④ S3 PutObject → 私有桶 push-assets/banner/<uuid>.png
                  ⑤ 生成签名短 URL /api/push/banner?k=<uuid>&sig=HMAC-SHA256
      → 渲染 preset card_json：card_image.url ← 签名短 URL（深度插值）
  → Novu → bridge → 企微 message/send
企微无会话抓图 → GET /api/push/banner?k&sig → 验签 → S3 GetObject 读回 PNG → 返回
定时清理：jobs/ 注册表每日清扫 >7 天 push-assets/banner/ 对象
```

## 3. 数据源（与报表页同一批视图、同口径）

三个 getter 复用 `web/lib/report-center/` 现有实现，但**不传 cookie**——引擎用组代签 JWT 作 PostgREST bearer（RLS 按 data_scope 裁剪，同 §6.1/§12.1）。查询逻辑与 getter 逐字一致，只是 client 来源不同。

| 板块 | 视图 | 行 | 展示 |
|---|---|---|---|
| KPI 卡片 | `report_achievement_gen`（target_level=total，status=active 当前周期） | 4 指标 | 达成值 + 达成率 |
| 品牌指标 | `report_brand_metric_gen` | 3 行（3120/64188/合计） | 品牌名 + 销售 + 达成率 |
| 门店战区表 | `report_region_breakdown_gen`（level=region） | 4 战区 | 战区名 + 销售达成 + 达成率（两列，最代表指标） |

> ⚠️ **PR #64 教训必须继承**：KPI 查询必须 `status=eq.active` + 当前周期单行（`order=start_date.desc&limit=1`），禁 SUM 全表跨周期——7月 closed + 8月 active 加总出假数。报表横幅数字必须与报表页显示的数一致。

**维度键映射**：
- 品牌行 = `system_book_code`（3120 熊喵 / 64188 品品甜），显示 `brand_name`
- 战区行 = region 级 `region_name`（东/南/西/中，来自 dim_war_zone is_assessed），显示 order 按 sale_rate desc
- 合计行（品牌板块）为视图自带合计行（sbc='' 或 total），显示「合计」

## 4. 对象存储（天翼云 OOS）

- **桶**：`lemeng-datasource`（现有私有桶，web 容器已注入 `S3_ENDPOINT/OOS_ACCESS_KEY/OOS_SECRET_KEY/OOS_BUCKET`）
- **前缀**：`push-assets/banner/`（独立文件夹，管理隔离）
- **键**：`push-assets/banner/<uuid>.png`（uuid 防遍历猜号）
- **可见性**：**私有桶 + 签名路由读回**——banner 是 RLS 保护的业务数据，禁止 public-read（可遍历/可转发/可爬取，与权限收缩工作相悖）。用户提议「新建公共读桶」**已否决**。
- **读写**：`@aws-sdk/client-s3`（web 已依赖，duckdb carry-dims 同款）。S3 兼容层（ZOS）的 PutObject/GetObject 行为首期须实测（endpoint 非标准 AWS，region/signature 差异）。

## 5. 签名短 URL 路由

`GET /api/push/banner?k=<uuid>&sig=<HMAC-SHA256 base64url>`

- 签名密钥 = `sha256(JWT_SECRET + ":push-banner")`（复用方案 C，不跨上下文复用裸 JWT_SECRET）
- 待签串 = `JSON.stringify([k, expiresAt])`——签名覆盖**过期时间**，防 URL 永久可访问
- 路由流程：验签（timingSafeEqual）→ 校验未过期 → S3 GetObject(`push-assets/banner/<k>.png`) → `Content-Type: image/png` + `Cache-Control: private, max-age=3600` 返回；验签失败/过期/对象不存在 → 403/404
- **无进程内 PNG 缓存**（对象存储即缓存；删了 GetObject 自然 404，不残留内存）
- 依赖注入保持 B2 原则：路由纯读对象，不查业务库

## 6. 可配置变量 report_banner

- 注册：`push_variables` 表 INSERT 一行（迁移 205，`ON CONFLICT DO NOTHING`）：
  ```sql
  ('report_banner', '报表横幅', NULL, 'total', NULL, 'URL', true)
  ```
  （metric_code NULL——非数值指标，无 registry 口径；scope_dim='total' 占位，实际渲染按组 scope 裁剪）
- 引擎解析：模板 card_json 深度插值前检测是否引用 `{{report_banner}}`——**未引用则跳过预渲染**（不浪费 S3 写入）。引用则按 §3 预渲染并把值设为签名短 URL
- 默认 preset：迁移 205 把 `scheduled-report-card` 的 `card_image.url` 从占位图改为 `{{report_banner}}`（ON CONFLICT DO UPDATE）
- 自定义模板：`card_image.url` 写 `{{report_banner}}` 即得动态报表横幅；不写则无横幅（无 S3 写入）

## 7. SVG 布局（1080×480，aspect 2.25）

三段式布局，保留报表页视觉语言（DESIGN.md：深蓝主色 #1E40AF + slate 中性 + 达成三色绿/琥珀/红 + tabular-nums）：

```
┌──────────────────────────────────────────────┐
│ 山海数据平台                   2026-08-20    │ 顶栏
├──────────────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │
│ │ 销售额  │ │ 配送额  │ │ 出库额  │ │ 出库毛利│ │ KPI 4 卡片（达成率三色）
│ │ ¥4.16M │ │ ¥…     │ │ ¥…     │ │ ¥…     │ │
│ │ 60.6%  │ │ …      │ │ …      │ │ …      │ │
│ └────────┘ └────────┘ └────────┘ └────────┘ │
├──────────────────────────────────────────────┤
│ 品牌×指标：熊喵  ¥…  61% │ 品品甜 ¥…  …% │ 合计 …│ 品牌 3 行
├──────────────────────────────────────────────┤
│ 门店战区   销售达成   达成率      │ 东  ¥…  …% │
│            …        …         │ 南  ¥…  …% │  战区 4 行
│                              │ 西  ¥…  …% │
│                              │ 中  ¥…  …% │
└──────────────────────────────────────────────┘
```

- 行高/字号缩放以实现：KPI 卡片区 ~40%、品牌行 ~20%、战区表 ~25%、顶栏 ~8%
- 达成率三色：≥100% 绿、≥60% 琥珀、<60% 红（与 DESIGN.md 一致）
- **字体**：扩展 `banner-font.ts` 子集——新增品牌/战区名等 dim 表**有限串** + 报表标签（销售/达成/出库/毛利/配送/品牌/合计/战区/门店 等）。字符串从 §3 视图值收集，fontTools subset 重生成。OFL 协议商用合规，SVG 自包含零 Dockerfile 改动
- tabular-nums：Noto Sans SC 数字默认等宽；金额格式与报表页一致（¥ + 千分位）

## 8. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 任一视图查不到数据（target 未激活/无战区） | 该板块留空占位（如「暂无数据」），其余板块正常渲染；**不整图失败** |
| S3 PutObject 失败 | 引擎记 push_trigger_logs skipped + 告警日志；`card_image.url` 回退占位图（**不投空 URL**——方案 C 既有 M7 行为） |
| 验签失败 / 过期 | 403 |
| GetObject 404（对象已清） | 404 → 企微侧图片加载失败，卡片其余内容正常 |

## 9. TTL 与清理

- 对象生命周期 7 天（对齐 push_trigger_payloads TTL）
- 新增 job `push-banner-cleanup`（`web/lib/jobs/push-banner-cleanup/manifest.ts` + registry.ts 追加一行）：每日 04:17 列 `push-assets/banner/`，删最后修改时间 >7 天的对象。模式复用 `push-ttl-cleanup`（tryAcquireLock + notifyWecom 告警）
- 无需 DB 元数据表（对象键时间戳即可判断）

## 10. 影响面

| 项 | 说明 |
|---|---|
| 改 web/ | 引擎报表变量解析 + banner-report 模块 + S3 客户端 + 路由改 S3 读回 + 字体子集扩展 + 新 job |
| 迁移 205 | push_variables 注册 `report_banner` + 种子 preset card_image.url 改 `{{report_banner}}` |
| 无 | 新表（复用 push_variables/push_message_presets）、function、nginx 改动均无 |
| 部署 | GHA 完整部署（改 web/ + 迁移） |

## 11. 非目标（YAGNI）

- ❌ 一比一复刻报表页（样式参考即可，已豁免）
- ❌ 门店级下钻表（只战区层）
- ❌ public-read 桶 / 前端直读 S3
- ❌ CDN/缓存层（对象存储 + 路由 max-age 足够）
- ❌ 自定义布局/主题（横幅布局引擎侧固定，模板只决定「要不要」）

## 12. 测试

- **单元**（banner-report 模块纯函数）：SVG 布局快照/断言含 KPI 值、品牌 3 行、战区 4 行；三色判定；空数据占位；签名/过期/验签失败
- **单测**：`report_banner` 模板引用 → 预渲染触发 + URL 注入；未引用 → 跳过不写 S3（mock S3 client）
- **契约**：路由验签与引擎签名字节级一致（复用方案 C 测试模式）
- **E2E（生产）**：deploy-web-1 内 node 用 JWT_SECRET 构造签名 URL → curl 200 image/png；bogus sig → 403；S3 对象存在；真实推送后企微拉图
