---
name: retail-query
description: 零售销售数据查询。用户问销售额/销量/订单/商品/门店/品类/利润/趋势等业务数据时激活，先用 list_datasets 看可用数据集，再用 query_retail_data 查。
metadata:
  openclaw:
    emoji: "📊"
---

# 零售数据查询 Skill

用户问**零售销售数据**（销售额、销量、订单数、商品排行、门店对比、品类占比、利润、环比趋势等）时使用。

## 工具

- **list_datasets()**：会话首查前调一次。返回可用数据集（明细/汇总/维表）+ 各列 + 成本敏感标记 + JOIN 提示 + 日期列/格式。**可用表/列以它返回为准，勿凭记忆。**
- **query_retail_data({ sql })**：单条 SELECT。自动按权限过滤门店、脱敏成本列——**不要**在 SQL 写权限条件。只允许 SELECT；禁 read_parquet/DDL/DML。无 LIMIT 时网关自动补 LIMIT 1000。结果超 50 行只回传前 50 + truncated。

## 五条原则

**0. 绝不编造数据（最高铁律）**：数据**只能**来自 query_retail_data 返回。工具没调/返回 error/返回空/拿不准时，如实说"我没能查到/当前无权限/该日无数据"，**绝对禁止**自编门店名、数字、排名、金额。宁可说查不到，绝不瞎编。

**0. 工具调用预算（铁律，超时主因）**：一个问题最多 **3 次** `query_retail_data`。优先一条 SQL 算完（聚合+JOIN+WHERE 一次到位）；不要多表交叉验证/反复核对口径；表/列不确定 → 先调 1 次 `list_datasets` 再直接查，禁止试探性查询。超过 3 次仍没结果 → 停止，如实说明已查到的部分和缺什么，不要继续钻。

**0.6 先查后答，禁止空谈计划（实测教训：thinking=off 时模型把「打算」当答案发出去）**：
- 回答需要数据 → **第一步就调 `query_retail_data`**，拿到结果再组织答案。
- **绝不**输出「我先查一下 / 我准备用 XX 列 / 让我看看 / 我直接用…」这类计划性文字作为最终答复。
  计划必须落在工具调用里执行，不是说出来；说了要做就立刻调用。

**0.5 权限预检（先查范围，无权限立即答，不浪费时间）**：
- 每次 `query_retail_data` 响应里的 **`perms.branch_nums`** 就是你的可见门店列表（网关按提问者权限裁剪后返回）。若为空数组 → 你无任何数据权限，直接告知用户「无数据查询权限」，**不再发起任何查询**。
- 问题涉及**具体战区/区域/门店**时，第一查就做范围确认，一条 SQL 搞定：
  `SELECT DISTINCT war_zone FROM report_region_breakdown_gen WHERE war_zone IS NOT NULL`
  （战区）或 `SELECT DISTINCT region_name FROM report_region_breakdown_gen WHERE region_name IS NOT NULL`（区域）。
  （该视图按你权限自动裁剪，返回即你的可见战区/区域全集。）
- 问题目标**不在**可见范围 → **立即**如实回答「该战区/区域不在你当前可见门店范围（你可见：东部战区…）」，并**结束**，禁止再查任何表验证/尝试绕过。
- 禁止为了确认范围做多表核对（dim_branch × 门店名匹配 × region 视图 × targets 交叉验证）——一次范围查询足够，多了就是超时主因。

**0.7 输出形态（实测：企微对话回复渲染纯文本，markdown 语法原样显示；唯一富格式=模板卡片）**：
- **数据类回答（排行/汇总/统计/确认/选择）默认输出模板卡片**（```json 代码块，插件自动提取发送、流式隐藏 JSON、字段自动补全）。
- 纯文本只用于：无数据/查询失败/对话解释/纠错提示。
- 纯文本时**禁止** markdown 语法（`**`、`##`、`- 列表`、管道符表格）——全部原样显示；用分隔线 + 全角空格对齐。
- **emoji 用法**：允许少量洋气/克制的装饰（✨ 🔥 💯 📈 💡 🎯 ⚡ 💎 🎉 ⭐）；**禁止** AI 味图标堆砌（🏆🥇🥈🥉📊✅🚚👇😄 等连续/每行一个），排名写「1.」、合计写「合计」。
- 金额 ≥1万 用「X.X 万」（1位小数），<1万 用「X 元」。

**0.8 模板卡片用法（数据回答首选）**：

- **排行/汇总 → text_notice 卡片**（sub_title_text 放完整排行列表；horizontal_content_list 放 Top 3 键值对）：
```json
{
  "card_type": "text_notice",
  "main_title": { "title": "东部战区本月门店销售排行" },
  "sub_title_text": "1. 曲靖XX店 12.5万（1320单）\n2. 曲靖XX店 10.2万（980单）\n3. 宣威XX店 8.7万（760单）\n4. 曲靖XX店 7.1万（690单）",
  "horizontal_content_list": [
    { "keyname": "1. 曲靖XX店", "value": "12.5万" },
    { "keyname": "2. 曲靖XX店", "value": "10.2万" },
    { "keyname": "3. 宣威XX店", "value": "8.7万" }
  ],
  "task_id": "task_rank_1787200000"
}
```
- **确认/选择 → button_interaction**（点击后 agent 收到 event_key 回调自动续查）：
```json
{
  "card_type": "button_interaction",
  "main_title": { "title": "需要怎么拆？" },
  "button_list": [
    { "text": "按门店拆", "key": "by_store", "style": 1 },
    { "text": "按区域拆", "key": "by_region", "style": 2 }
  ],
  "task_id": "task_confirm_1787200000"
}
```
- **投票/多选 → vote_interaction / multiple_interaction**（简化格式：title/options/mode/submit_text 或 title/selectors；源码自动回写选中标记 is_checked/selected_id + 提交后 disable，防重复提交）。
- 规则：task_id=`task_{场景}_{时间戳}`（仅字母数字_-@）；按钮/horizontal 各 ≤6；标题 ≤26字；**标题/文案不用 emoji 图标**（AI 味重，用纯文字）；不确定 schema 先读 wecom-send-template-card skill；JSON 只放 ```json 代码块，正文放代码块外。

**0.7.5 配送/出库查询直连（防探索性多查，实测教训）**：
- 配送/出库/达标率排行 → **直接查 `report_region_breakdown_gen`**（level='store'，字段 delivery_actual/delivery_target/delivery_rate）。
- **不要先试 `delivery_detail`/`wholesale_detail`**（明细表未放行，会被拒）。
- **周期过滤**：该视图混 7月/8月多期，必须过滤当月：`WHERE level='store' AND target_id=823`（823=8月经营指标，22=7月）；不确定 target_id 时先 `SELECT DISTINCT target_id, start_date, end_date FROM report_region_breakdown_gen` 一次确认。

**0.8 企微富能力（模板卡片 / 文件交付 / 交互，全部原生可用）**：

- **排行/汇总/通知 → 输出模板卡片**（回复里放 ```json 代码块，插件自动提取发送、流式隐藏、字段自动修正；代码块外文字照常发）。示例（text_notice + 水平键值）：
```json
{
  "card_type": "text_notice",
  "main_title": { "title": "东部战区本月门店销售排行" },
  "sub_title_text": "8月1日~8月20日 · 明细实时口径",
  "horizontal_content_list": [
    { "keyname": "1. 曲靖XX店", "value": "12.5万" },
    { "keyname": "2. 曲靖XX店", "value": "10.2万" },
    { "keyname": "3. 宣威XX店", "value": "8.7万" }
  ],
  "task_id": "task_rank_1787200000"
}
```
（task_id 格式 `task_{场景}_{时间戳}`，仅字母数字_-@；按钮≤6个、horizontal 项≤6条、标题≤26字；其余排行项放 sub_title_text 或正文。）

- **确认/选择 → button_interaction 按钮卡片**：用户点击后 agent 会收到「[企业微信模板卡片回调] event_key=…」消息，**按 event_key 继续查询**（闭环原生支持）：
```json
{
  "card_type": "button_interaction",
  "main_title": { "title": "需要怎么拆？" },
  "button_list": [
    { "text": "按门店拆", "key": "by_store", "style": 1 },
    { "text": "按区域拆", "key": "by_region", "style": 2 }
  ],
  "task_id": "task_confirm_1787200000"
}
```

- **文件/图片/语音交付 → `MEDIA: /绝对路径` 指令**（行首，每个文件一行，路径放 ~/.openclaw/workspace/ 下）：把生成的 CSV/图表/文件作为图片或文件消息发出，**不要说"发不了文件"**。

- **入站媒体**：用户发语音（自动转文字）、图片/文件/视频（URL 可下载解析）——能理解就理解，不能就如实说。

- 卡片 JSON 只输出在 ```json 代码块里，不要夹带其他 JSON；不确定 schema 时先读 wecom-send-template-card skill 的参考文档。

**0.9 语义澄清机制（交互式，不猜）**：
- 问题**语义不明 / 多口径歧义**时（多个候选 target/指标/维度，且无法从上下文确定）→ **先输出澄清卡片让用户选择，不要猜一个口径直接答**。
  典型歧义：问「销售达成率」但有 7月/8月 两个目标期 × 销售/配送/出库/出库毛利 多个指标；问「本月排行」但没说门店/区域/商品。
- 澄清用 **`vote_interaction` 单选卡片**（源码机制：用户选择提交后选项带勾选标记 is_checked 且整体禁用，天然防重复提交；简化格式自动转 API）：
```json
{
  "card_type": "vote_interaction",
  "title": "哪个口径的达成率？",
  "description": "当前有多个目标期与指标，请选择",
  "options": [
    { "id": "aug_sale", "text": "8月·销售" },
    { "id": "aug_delivery", "text": "8月·配送" },
    { "id": "aug_outbound", "text": "8月·出库" },
    { "id": "jul_sale", "text": "7月·销售" }
  ],
  "mode": 0,
  "task_id": "task_clarify_1787200000"
}
```
（vote/multiple 卡片才带选中标记+提交禁用；**button_interaction 按钮没有标记机制**，只用于触发动作如"重新查一下"。选项≤20、标题/按钮文案短（≤20字），完整说明放正文不放卡片，防截断。）
- **点击回流**：用户选择提交后，你会收到一条 `[企业微信模板卡片回调]` 消息，内含 `event_key(事件 key): aug_sale` 和 `selected_items` 字段。**看到回调就按 event_key 对应的口径立即查询回答，不要重问、不要解释卡片机制**。
- 澄清卡片文案要包含候选含义（如"8月·销售"）；一次只澄清一个维度（先口径再维度，别一次问太多）。
- 只有真歧义才澄清：能从上下文/历史确定口径时直接查，不要为了澄清而澄清。

**1. 忠于用户原话**：说"前 N/Top N"→加 LIMIT N；说"排名/所有/全部"→不写 LIMIT（网关兜底），呈现时如实告知总数与是否截断。点名某店/品类→LIKE '%关键字%'；没点名→全量（权限自动过滤）。

**1.5 报表口径铁律（与报表中心 100% 一致）**：
- 报表中心有的口径（**区域/战区排行、达标率、汇总、趋势、品类出库、批发**）→ **必须查 `report_*_gen` 视图**
  （report_region_breakdown_gen / report_achievement_gen / report_category_summary_gen / report_brand_metric_gen /
   report_wholesale_*_gen / report_supply_chain_outbound_gen）——这些视图就是报表中心的数据源，
  **同视图同 SQL = 数字逐字节一致**。
- **禁止用 `retail_detail` 自行聚合替代报表口径**（明细聚合无评估门店/目标关联等口径，数字对不上报表中心）。
  区域排行示例：`SELECT sub_region_name, SUM(sale_actual) FROM report_region_breakdown_gen WHERE level='sub_region' GROUP BY 1`。
- `retail_detail` 只用于报表中心**没有**的自由分析（商品级、任意日期切片、自选维度）——此类无对应报表，无一致性概念。

**2. 日期忠于原话 + 必须显式标注**：明细日期列 `order_detail_bizday`（YYYYMMDD 字符串）；汇总日期列 `biz_date`/`week_start`（DATE）。"今天/最近/最新"用一条 SQL：`WHERE 日期列=(SELECT MAX(日期列) FROM 表)` 并带出 `data_date`；若 data_date≠今天就说"今天暂无，以下为最新 data_date 的数据"。回答里始终写明数据属于哪一天，绝不拿旧日冒充今天。按北京时间（容器 Asia/Shanghai）。

**2.5 区域聚合免 join（首选）+ JOIN 复合键铁律**：
- **retail_detail 已自带区域列**：`region_name`（东部一区…）、`war_zone_name`（东部战区）、`system_book_code`（3120/64188）。
  区域/战区排行**直接** `GROUP BY region_name`（或 war_zone_name），**不要 join 任何维表**：
  `SELECT region_name, SUM(CAST(sale_money AS DOUBLE)) FROM retail_detail WHERE substr(order_detail_bizday,1,6)='202608' GROUP BY 1`。
- 若必须 join 维表（如要品牌名/商品名）：`branch_num` 跨品牌共享（3120/64188 同号不同店），**必须用复合键** `ON rd.system_book_code = db.system_book_code AND rd.branch_num = db.branch_num`；
  **禁止** `ON rd.branch_num = db.branch_num` 裸键 join（网关会拒绝并报 forbidden_branch_join；
  裸键会把本战区数据扇出错标成其他战区/品牌，金额是重复计数假象）。

**3. 成本列无权限 = NULL，别当 0**：成本/利润为 NULL（无权限）→如实说"成本列无权限"，**别把 NULL 当 0 算进总额**（list_datasets 里 is_sensitive=true 的列即为成本组）。

**4. 一问一查**：能一条 SQL 搞定别拆多条。总额/计数/排名/占比用 SUM/COUNT 聚合，别把明细拉回来自己算。

## 选明细还是汇总（汇总优先）

**优先命中汇总/生成视图**：战区/门店销售/配送/出库下钻 → `report_region_breakdown_gen`（含 sale_actual/sale_target/sale_rate/daily_sale）；品类出库 → `report_category_summary_gen`；品牌指标 → `report_brand_metric_gen`；批发 → `report_wholesale_daily_gen`/`report_wholesale_customer_gen`；周趋势 → `report_weekly_trend`（全部 scope_branch_keys 行级裁剪、成本列自动脱敏）。只有下列情况才扫 `retail_detail` 明细：
- 问**今天/最近**（汇总表可能滞后约 1 天）。
- 要**单笔订单、具体商品行**等明细。
- 汇总表没有的维度。

维表（dim_item/dim_branch/dim_region）可直接查做 lookup（如"有哪些门店/战区"）。按战区/品类聚合历史 → 用汇总表 JOIN 维表；明细级 × 维度归类待 carry（C3）。

## 目标与达成率（report_achievement_gen）

用户问"达成率/目标进度/谁没达标/目标复盘/还差多少"→ 查 `report_achievement_gen`（旧名 `report_achievement_v` 为兼容别名，等价可查，但新查询统一用 gen）（每目标×指标一行，含 target_value/actual_value/achievement_rate/progress_rate/status/data_status）。

- **多层级汇总**（战区/品牌/区域）：`SELECT war_zone, SUM(actual_value) actual, SUM(target_value) target, SUM(actual_value)/NULLIF(SUM(target_value),0) rate FROM report_achievement_gen WHERE metric_code='sale' GROUP BY war_zone`。
- **status**：active=进行中，看 `progress_rate`（是否跑赢进度，按已过天数折算）；closed=已结束，看 `achievement_rate`（固化复盘值，不再变）。
- **data_status**：`not_ready`=该指标数据源未接入（如拿货），actual 不可用 → 如实说"该指标暂未接入"；`missing`/`partial`=report 数据不全，actual 偏低别当真实达成。
- 列表/排名用 LIMIT；点名某店/战区 WHERE 过滤。权限自动按门店裁，别手写权限条件。
- 定时推送「目标进度/复盘」→ create_scheduled_report 用 sr_mode=sql + query_intent 写明（如"本周各战区销售达成率"），cron turn 会查 report_achievement_gen。

## 配送明细（delivery_detail）

用户问"配送/调出/拿货量/配送毛利/中心发了多少货给某店"→ 查 `delivery_detail`（配送中心调出门店的明细，每条=一个调出单的商品行）。

- **门店拿货量**：`SUM(CAST(out_amount AS DOUBLE))` 按 `response_branch_num` 聚合（调出方 `distribution_branch_num`=99 固定是配送中心）。
- **配送毛利**：`SUM(CAST(profit_money AS DOUBLE))`；成本/毛利列（cost_price/cost_unit_price/profit_money）无权限=NULL。
- 按日过滤：`order_time LIKE '20260712%'`（列是 `YYYY-MM-DD HH:MM:SS` 字符串，取前 8 位比 YYYYMMDD）。
- 全字符串列，数学运算须 CAST；JOIN dim_branch(`response_branch_num`)/dim_item(`item_num`) 看店名/商品名。只 3120 采集，64188 共用此数据。

## 批发销售明细（wholesale_detail）

用户问"批发/批发销售/批发毛利/某客户批发额/大客户拿货"→ 查 `wholesale_detail`（批发销售明细，每条=一个批发销售单的商品行）。

- **客户批发额**：`SUM(CAST(wholesale_money AS DOUBLE))` 按 `client_name`/`client_code` 聚合；批发量 `SUM(CAST(wholesale_num AS DOUBLE))`。
- **批发毛利**：`SUM(CAST(wholesale_profit AS DOUBLE))`；成本/毛利列（wholesale_cost/wholesale_profit）无权限=NULL。
- 按日过滤：`audit_time LIKE '20260710%'`（列是 `YYYY-MM-DD HH:MM:SS` 字符串，取前 8 位比 YYYYMMDD）。
- 全字符串列，数学运算须 CAST；JOIN dim_branch(`branch_num`)/dim_item(`item_num`) 看店名/商品名。只 3120 采集。

## 定时推送应用（用户说"每天X点推Y"时）

调 **create_scheduled_report** 一步完成（工具内部建 cron + 写绑定）：
- name：应用名
- schedule：用户说的时间（每天9点=`{kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}`；每小时=`{kind:'every',everyMs:3600000}`）
- sr_mode：标准报表（业绩/周报/品类排行）→ template + template_key；个性化 → sql + query_intent
- run_as/delivery_to 自动=你本人（钉死，不可改）

cron 触发时（自动 agent turn）务必高效、不重复：
- **一问一查**：先调一次 `list_datasets` 看列，然后**一条**聚合 SQL（COUNT/SUM/GROUP BY）搞定。**禁止**反复 query 试错（列名一次看清，别查 5 次以上）。
- **只用 `push_report` 推送一次**（收件人自动从绑定取）。**禁用 `send_notify`**——cron turn 无 @sender 会推默认组且与 push_report 重复推送。
- **不要**手动用 cron 工具建定时（已被禁用，走 create_scheduled_report）。

**删除定时**：用户说"取消/删除某定时"→ 调 `delete_scheduled_report`(cron_job_id，建时返回的 id)。

## 呈现

中文回答，关键数字带单位 + 日期。**直接给结果**，不要"查询成功/我来查一下"等铺垫。truncated 时改用聚合/加 LIMIT 重查，或说明"共 N 条，此处列前 50"。
