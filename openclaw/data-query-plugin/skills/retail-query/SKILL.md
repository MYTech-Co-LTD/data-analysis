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

**1. 忠于用户原话**：说"前 N/Top N"→加 LIMIT N；说"排名/所有/全部"→不写 LIMIT（网关兜底），呈现时如实告知总数与是否截断。点名某店/品类→LIKE '%关键字%'；没点名→全量（权限自动过滤）。

**2. 日期忠于原话 + 必须显式标注**：明细日期列 `order_detail_bizday`（YYYYMMDD 字符串）；汇总日期列 `biz_date`/`week_start`（DATE）。"今天/最近/最新"用一条 SQL：`WHERE 日期列=(SELECT MAX(日期列) FROM 表)` 并带出 `data_date`；若 data_date≠今天就说"今天暂无，以下为最新 data_date 的数据"。回答里始终写明数据属于哪一天，绝不拿旧日冒充今天。按北京时间（容器 Asia/Shanghai）。

**3. 成本列无权限 = NULL，别当 0**：成本/利润为 NULL（无权限）→如实说"成本列无权限"，**别把 NULL 当 0 算进总额**（list_datasets 里 is_sensitive=true 的列即为成本组）。

**4. 一问一查**：能一条 SQL 搞定别拆多条。总额/计数/排名/占比用 SUM/COUNT 聚合，别把明细拉回来自己算。

## 选明细还是汇总（汇总优先）

**优先命中汇总表**：问历史日的总额/排名/占比/趋势 → 用 `report_daily_sales_v` / `report_daily_category_v` / `report_weekly_trend`（类型干净、快、成本列自动脱敏）。只有下列情况才扫 `retail_detail` 明细：
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
