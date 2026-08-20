# 推送自助配置平台（push self-service config）设计

> 日期：2026-08-20 · 状态：已与用户逐节确认 · 上游：architecture.md §7.4（Novu 推送中心）、`docs/ops/wecom-message-capabilities.md`
> 背景：推送链路（run_push 引擎 → Novu → bridge → 企微 news_notice 卡片）已生产验证；本设计把「配模板 / 配收件人 / 配时间 / 选目标」交给业务侧自助操作。

## 1. 目标与非目标

**目标**：推送管理员（`push:configure` 持有者）在 web 管理端自助完成：

1. 配消息模板（企微 news_notice 卡片：区域级字段 + 高级区域，变量点选，实时预览，测试发给自己）
2. 配推送任务（收件人 selector + 定时 + 数据源目标选择）
3. 目标结束自动停推（含一次性提醒），目标轮换自动跟随

**非目标（明确不做）**：

- Novu 侧任何改动（模板/步骤/渠道——§7.4 边界：单 step 单变量 `{{{message_content}}}` 透传不动）
- N5 OpenClaw push-admin 插件（二期，接本设计的同一 CRUD API）
- 邮件等其它渠道、Digest 聚合（§7.4 🔜 档，另行立项）
- 消息类型扩展（统一 `template_card news_notice`，2026-08-20 已裁定）

## 2. 决策记录（brainstorming 用户拍板）

| # | 决策 | 选择 |
|---|---|---|
| 1 | 使用范围 | 仅推送管理员（`push:configure`），不做部门隔离 |
| 2 | 模板自由度 | 区域级 + 高级区域（引用块/左图右文/多区域独立跳转均可配） |
| 3 | 变量面 | 核心指标一次补齐 ~8 个（引擎 `METRIC_TO_VIEW` 已就绪） |
| 4 | 测试发送 | 仅发操作者自己；正式发送只由定时任务触发 |
| 5 | 数据模型 | 模板库 + 任务引用（两表，preset 可复用，两个管理入口） |
| 6 | 目标选择默认值 | 新建任务默认勾「自动跟随当前进行中」（跟随模式），可切「指定目标」 |
| 7 | 多目标口径 | 取值改「今天落在周期内」；结束守卫跳过 + owner 一次性提醒 |

## 3. 数据模型与目标取值

### 3.1 表结构

**`push_presets`（模板库——由 `push_message_presets` 演进）**

```sql
preset_id   TEXT PRIMARY KEY
name        TEXT NOT NULL                 -- 新增：模板名（管理页列表显示）
msgtype     TEXT NOT NULL DEFAULT 'template_card'   -- 统一 news_notice 呈现，text/markdown 保留兼容
card_json   JSONB                        -- 完整企微 card 对象模板（{{var}} 深度插值，203 已建）
enabled     BOOLEAN NOT NULL DEFAULT true
updated_by  TEXT / updated_at TIMESTAMPTZ
-- workflow_id 列退役为可选关联（旧 scheduled-report 行兼容保留，引擎不再按它查找）
```

**`push_configs`（推送任务——新表，替代旧 `scheduled_reports` 角色）**

```sql
config_id           UUID PRIMARY KEY
name                TEXT NOT NULL
cron_spec           JSONB NOT NULL        -- 结构化频率：{kind: daily|weekly|monthly, time: "08:30", weekday?: 1-7, day?: 1-31}
enabled             BOOLEAN NOT NULL DEFAULT true
selector_json       JSONB NOT NULL        -- {kind: dept|person, ids: [...]}（复用引擎 selector 语义）
target_mode         TEXT NOT NULL DEFAULT 'follow' CHECK (target_mode IN ('follow','fixed'))
target_id           BIGINT                -- fixed 模式必填 → targets.id
preset_id           TEXT NOT NULL REFERENCES push_presets
owner_wecom_id      TEXT NOT NULL         -- 结束提醒收件人 + trigger 日志 operator
last_run_date       DATE                  -- 当日补发判定
last_run_txn_id     TEXT                  -- 管理页可点跳排查
last_guard_notice_at TIMESTAMPTZ          -- 结束提醒防重
created_at / updated_at
```

旧 `scheduled_reports` 表退役（生产 0 行，标记 deprecated 不迁移数据）。

### 3.2 目标取值——follow/fixed 落为查询参数（核心设计）

`resolveNumericValue` 现查询 `report_achievement_gen?status=eq.active&order=start_date.desc&limit=1` 的两个坑：最新 ≠ 进行中（提前建下月会切错）、多 active 周期静默取一（生产实况：7月残留 22 行 active 与 8月并存）。改为：

```
follow（默认）: + &start_date=lte.<今天> &end_date=gte.<今天>
fixed        : + &target_id=eq.<target_id>        （视图需补 target_id 输出列）
```

语义自然成立：周期结束 → 查询取不到 → 变量跳过；提前建下月（start_date 未到）不误取；月+季并行时按组 RLS 裁剪（视图按组 JWT 的 data_scope 裁品牌/门店，多目标歧义大多被 RLS 消化）。**follow 多行 tie-break 规则（明确化）**：区间过滤后仍多行（如月度+季度目标同 active）时 `order=start_date.desc,end_date.asc&limit=1`——取开始最晚、结束最早的周期（=粒度最细/最近的周期，8月优先于 Q3）。引擎架构零改动（仍查视图，仅 URL 参数变化）。

### 3.3 变量面扩展

`push_variables` 补齐核心指标（var_code 沿用现有命名风格）：现有 sale_amount / achievement_rate / detail_url，新增 **delivery_amount / delivery_rate / outbound_amt / outbound_profit** 四行。`METRIC_TO_VIEW` 映射已含全部所需 metric_code（sale / sale_rate / delivery / outbound_amt / outbound_profit）——rate 类按视图 `achievement_rate` 列取，零引擎代码改动。

### 3.4 结束守卫

scheduler 触发前：follow 试查「今天落区间」是否有行 / fixed 查目标 status。无进行中目标 → 跳过本次 + 向 owner 发一次性企微提醒「目标已结束，推送任务已暂停」（`last_guard_notice_at` 24h 防重）。不静默停、不报错刷屏。

## 4. 管理页与 API

入口：`web/app/admin/push/`（复用现有 admin 框架模式，UI 遵循 DESIGN.md），全部过 `push:configure` 闸。

### 4.1 模板页 `admin/push/presets`

- **列表**：模板卡片（名称 + 缩略预览 + 启用开关 + 「被 N 个任务引用」）；被引用的模板不可删（提示引用清单）
- **编辑器**：按企微卡片区域建模的表单——主标题/副标题/来源行/大图（URL 或上传至 web/public/push/）/键值行 0-4/整卡跳转；高级区域可增删（引用块/左图右文/区域独立跳转）
- **变量点选器**：拉 `push_variables` 启用变量，点击插入光标处（业务人员不写 `{{}}` 语法）
- **实时预览**：右侧按 `card_json` 渲染企微 news_notice 卡片 mock，改动即时刷新
- **测试发送**：一键发到操作者自己企微（走引擎完整链路：真实数值 + 真实卡片）

### 4.2 任务页 `admin/push/configs`

- **列表**：名称/频率/收件人摘要/目标模式/模板/启用/最近 txnId
- **编辑**：名称 → 频率控件（每天/每周几/每月几号 + 时刻，存 `cron_spec`，业务不见 cron 表达式）→ 收件人 selector（部门树/人员搜索）→ 目标模式（默认勾「自动跟随当前进行中」；切「指定目标」出现下拉）→ 模板下拉 → 启停
- 列表/编辑页显示**下次触发时间**（前端按 cron_spec 计算）

### 4.3 API

- `/api/admin/push-presets`、`/api/admin/push-configs`：CRUD（现有 admin route 模式 + `push:configure` 闸）
- `/api/push` 扩展：`presetId` 参数（按 presetId 直取 preset，替代按 workflow_id 查找）+ `selfTest: true`（服务端强制 selector=操作者本人，不信任前端传入）
- preset 保存时服务端校验 card_json：企微字段限制（标题≤128B/描述≤512B/card_action.url≤1024B 等，规则表来自 wecom-message-capabilities.md）

## 5. 调度与执行链路

`jobs/scheduled-reports` 演进（节拍不变）：

```
每小时扫描
  → RPC 拉 enabled push_configs（新 RPC，替代缺失的 get_due_scheduled_reports）
  → JS 按 cron_spec 判定「今日 due 且 last_run_date < 今天」
      （自写 daily/weekly/monthly 匹配，不引 cron 库；当日内补发：08:30 错过 09:00 补上，跨日不补；
        monthly 指定日期当月不存在——如 31——则当月跳过）
  → 目标守卫（§3.4）：无进行中目标 → 跳过 + owner 一次性提醒
  → 调 /api/push { presetId, selector, userId: config.owner, deliver: true }
  → txnId 回写 config.last_run_txn_id / last_run_date
```

- **Novu workflow 统一**：全部任务共用 `scheduled-report` workflow（修正旧 manifest 拼 `scheduled:<id>` 与 Novu identifier/preset 的错位）；Novu 零改动
- **错误处理**：单任务失败不阻断其它（for-loop try/catch 保留）；推送 paused 闸照旧；job 全量失败 status=error 进现有监控

## 6. 测试

- 引擎取值 URL 回归断言：follow 带 `start_date=lte`+`end_date=gte`；fixed 带 `target_id`（照 §12.1 修复的回归测试样式）
- 结束守卫：跳过 + 24h 防重 + 提醒发送
- cron_spec 匹配单测：daily/weekly/monthly、当日补发、跨日不补
- preset CRUD 权限闸（无 push:configure → 403）；card_json 校验规则
- selfTest 强制本人（伪造 selector 被覆盖）
- 现有 75 个推送测试不回归

## 7. 实施拆分建议（供 writing-plans 参考）

1. 迁移：push_presets 演进 + push_configs 建表 + 视图补 target_id 列 + 变量 INSERT
2. 引擎：resolveNumericValue follow/fixed 参数 + /api/push presetId/selfTest
3. 调度：job 改造 + cron 匹配 + 守卫
4. 管理页：presets 页（表单/点选/预览/测试）→ configs 页（表单/selector/目标模式）
5. E2E：建模板 → 建任务 → 到点触发 → 张铎收卡片
