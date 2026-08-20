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

**0.6.5 数据排行必须出卡片（铁律）**：查完数据给出排行/汇总时，**必须**在回复里输出 ```json 模板卡片代码块（text_notice + horizontal_content_list 表格），不能只给纯文本。卡片 JSON 写不全会导致用户看不到富格式——务必按 0.8 的完整示例生成（card_type/main_title/horizontal_content_list/card_action/task_id 齐全）。只有纯对话/解释/无数据才不用卡片。

**0.7 输出形态（企微对话回复=纯文本，markdown 语法不渲染会原样显示）**：
- 默认输出**干净纯文本**：排行/汇总用「1. 名称 —— 金额（单数）」编号行 + 简洁分隔线（`──`），结构：标题行 → 排行 → 合计。
- **不要用** markdown 语法（`**加粗**`、`## 标题`、`| 表格`、`- 列表`）——企微纯文本原样显示成星号井号管道符，很难看。
- **emoji**：允许少量克制点缀（✨💯🎯 等），**不要**每行堆砌（🏆🥇✅📊 连用）。
- 金额 ≥1万 用「X.X 万」（1位小数），<1万 用「X 元」；数字四舍五入。
- 完整数据直接写在回复里（不要藏），卡片只用于交互选择。

**0.8 卡片 = 数据表格 + 交互选择（企微纯文本无表格，表格只能靠卡片）**：
- **排行/汇总数据 → `text_notice` 卡片表格**（horizontal_content_list 键值行 = 企微唯一表格样式；Top6 用表格行 + emphasis_content 强调合计 + sub_title_text 放其余排名/口径）：
```json
{
  "card_type": "text_notice",
  "main_title": { "title": "东部战区·8月门店销售排行" },
  "emphasis_content": { "title": "469.7万", "desc": "8月销售合计" },
  "horizontal_content_list": [
    { "keyname": "1. 四川会东2店", "value": "28.9万" },
    { "keyname": "2. 熊喵西昌1店", "value": "19.6万" },
    { "keyname": "3. 曲靖会泽5店", "value": "16.0万" },
    { "keyname": "4. 曲靖会泽1店", "value": "15.3万" },
    { "keyname": "5. 曲靖陆良6店", "value": "14.9万" },
    { "keyname": "6. 品品甜文山丘北1店", "value": "13.4万" }
  ],
  "sub_title_text": "7. 四川会东1店 13.3万\n8. 熊喵罗平马街镇1店 11.9万\n9. 四川凉山宁南1店 11.3万\n10. 熊喵会东3店 11.1万\n\n口径：8月1日~20日 明细实时",
  "card_action": { "type": 1, "url": "https://data.shanhaiyiguo.com" },
  "task_id": "task_rank_1787200000"
}
```
- **语义澄清/维度选择 → `vote_interaction` 单选**（用户点选，0.9）；**确认 → `button_interaction`**；**多维度 → `multiple_interaction`**。
- **对话/解释/无数据 → 纯文本**（0.7 编号行+分隔线+合计）。
- 限制：horizontal ≤6 行（表格上限）、vertical ≤4（仅 news_notice 需图）、按钮 ≤6、标题 ≤26字；文案不用 emoji 堆砌；不确定 schema 读 wecom-send-template-card skill。

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
