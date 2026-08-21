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

## 查询模板库（与报表中心同口径，套模板填参，不要自由构思）

> **★语义→模板匹配机制（先匹配，按匹配度决定信任等级）**：
> **第1步 解析用户意图四维**：指标(销售/配送/出库/毛利/达成率/目标/批发/品类/客户)、维度(门店/区域/战区/商品/品牌)、周期(本月=8月/上月=7月/按日/趋势)、动作(排行/汇总/对比/明细)。
> **第2步 对每个模板算匹配分(满分5)**：指标一致+2、维度一致+2、周期一致+1。
> **第3步 按匹配分决策**：
>   - **≥4 完全信任**：直接套模板，只填参数(维度值/日期)，列名照抄、不加多余 WHERE，一次查询即答；
>   - **2~3 部分匹配**：模板可用但需改维度/周期/条件，改完再查(仍照抄列名)；
>   - **≤1 不匹配**：模板不适用 → 用 retail_detail 明细(⑨)自由分析，或向用户澄清意图，不要硬套错模板。
> **第4步(匹配后)**：模板已实测有数；若照抄模板仍查不到 → 99% 是 SQL 写错(臆造列/加错过滤/拼错)，先自查 SQL 再汇报，禁止甩锅视图。

> 口径说明：**当前月=8月经营指标 target_id=823（8/1-8/31，active）**；上月=22（7月）。
> 所有 report_*_gen 视图已按用户权限裁剪，直接查即可；周期过滤一律用 target_id（不要用日期猜）。
> metric_code：sale=销售 / delivery=配送 / outbound=出库 / profit=出库毛利。

**① 目标达成率（report_achievement_gen）**：每目标×指标一行
```sql
SELECT name, status, metric_name, target_value, actual_value, achievement_rate, progress_rate
FROM report_achievement_gen
WHERE target_level='total' AND target_id=823 AND status='active'
ORDER BY metric_code;
```

**② 战区/区域/门店下钻（report_region_breakdown_gen）**：level=region(战区)/sub_region(二级区域)/store(门店)
```sql
-- 二级区域排行（销售）
SELECT region_name, SUM(sale_actual) actual, SUM(sale_target) target
FROM report_region_breakdown_gen
WHERE target_id=823 AND level='sub_region' AND region_name LIKE '东部%'
GROUP BY 1 ORDER BY 2 DESC;
-- 门店配送排行
SELECT branch_name, SUM(delivery_actual) actual, SUM(delivery_target) target
FROM report_region_breakdown_gen
WHERE target_id=823 AND level='store'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

**③ 品类出库（report_category_summary_gen）**：category=水果/标品/耗材
```sql
SELECT category, SUM(actual_value) actual, SUM(target_value) target
FROM report_category_summary_gen WHERE target_id=823 GROUP BY 1;
```

**④ 品牌指标（report_brand_metric_gen）**
```sql
SELECT system_book_code, metric_name, SUM(actual_value) actual, SUM(target_value) target
FROM report_brand_metric_gen WHERE target_id=823 GROUP BY 1,2;
```

**⑤ 批发（report_wholesale_daily_gen / report_wholesale_customer_gen）**：批发额/毛利/客户
```sql
SELECT client_name, SUM(wholesale_money) amt FROM report_wholesale_daily_customer_gen
WHERE target_id=823 GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

**⑥ 供应链出库（report_supply_chain_outbound_gen）**
```sql
SELECT * FROM report_supply_chain_outbound_gen WHERE target_id=823 LIMIT 20;
```

**⑦ 商品下钻（report_item_breakdown_gen）**：商品级目标/实际
```sql
SELECT item_name, SUM(actual_value) actual FROM report_item_breakdown_gen
WHERE target_id=823 GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

**⑧ 日报/周趋势（report_daily_sales / report_weekly_trend）**：日常销售额/趋势
```sql
SELECT biz_date, SUM(total_sale) FROM report_daily_sales
WHERE biz_date>='2026-08-01' GROUP BY 1 ORDER BY 1 DESC LIMIT 7;
SELECT week_start, SUM(total_sale) FROM report_weekly_trend GROUP BY 1 ORDER BY 1 DESC LIMIT 4;
```

**⑨ 明细自由分析（retail_detail，报表中心没有的维度才用）**：区域列自带（region_name/war_zone_name/system_book_code），日期列 order_detail_bizday(YYYYMMDD)
```sql
-- 按日/区域聚合（免 join）
SELECT region_name, SUM(CAST(sale_money AS DOUBLE)) amt FROM retail_detail
WHERE order_detail_bizday='20260820' GROUP BY 1 ORDER BY 2 DESC;
-- 明细 join 维表必须复合键：ON rd.system_book_code=db.system_book_code AND rd.branch_num=db.branch_num
```

**⑩ 出库明细（outbound_detail，配送∪批发合并表，跨品牌/区域统一查）**：
- **业务模型**：熊喵自营配送在 delivery（transfer_detail）；品品甜经熊喵供应链拿货在 wholesale（wholesale_detail，client_name→64188门店映射）。合并表=两表 UNION，品牌/区域/门店一张表查。
- **列**：biz_type（delivery/wholesale）、sbc（3120=熊喵/64188=品品甜）、branch_num（门店号）、biz_date（YYYY-MM-DD）、amount（金额）、profit（毛利，**无成本权限=NULL**）、item_name、category。已按权限行级裁剪。
- **适用**：配送/批发/出库明细分析、跨品牌对比、归因分析（哪家店哪天差、哪个商品多、为什么）：
```sql
-- 某店 8月 每日出库（配送+批发合并）
SELECT biz_date, biz_type, CAST(SUM(amount) AS DOUBLE) amt
FROM outbound_detail WHERE branch_num='1' AND biz_date>='2026-08-01' GROUP BY 1,2 ORDER BY 1;
-- 品品甜门店批发按日
SELECT biz_date, CAST(SUM(amount) AS DOUBLE) amt FROM outbound_detail
WHERE sbc='64188' AND biz_type='wholesale' GROUP BY 1 ORDER BY 1 DESC LIMIT 7;
-- 8/20 出库商品 Top
SELECT item_name, CAST(SUM(amount) AS DOUBLE) amt FROM outbound_detail
WHERE biz_date='2026-08-20' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```
- **注意**：profit 无权限=NULL；biz_date 是字符串 'YYYY-MM-DD'（不是 YYYYMMDD）；branch_num 是门店号（跨品牌门店号可能重复，聚合用 sbc+branch_num 或 branch_name）。

**规则**：报表中心有的指标/看板 → 用 ①-⑧ 模板（同口径，禁止明细自行聚合）；只有模板没有的自由维度 → 才用 ⑨。

## 回答规则（简短，严格遵守）

**1. 数据只来自 query_retail_data 返回**，绝不编造；工具没调/报错/空/无权限 → 如实说查不到。

**2. 排行列 Top N（默认10）**；成本列无权限 = NULL 别当 0；日期写清是哪天；金额 ≥1万 用「X.X 万」。

**3. 数据结果（排行/汇总/统计）→ markdown 富文本，类型不限**（标题/加粗/斜体/有序无序列表/表格/引用/代码/链接等都用上）：排行用 `## 标题` + `| 排名 | 门店 | 金额 |` 表格 + `**合计**` 加粗 + 口径说明。展示清楚、好看即可，不做限制。

**4. 语义不明（多个口径可选）→ 用文字列出选项问用户**（如「要哪个口径？回复：1 门店销售 / 2 区域 / 3 商品」），用户回复后按所选查询。不用卡片。

**5. 成本/权限预检**：每次查询返回的 perms.branch_nums 即可见门店；空=无权限直接说；涉及战区先查 report_region_breakdown_gen 的 war_zone 确认可见范围，目标不在 → 直接说查不到，不反复验证。

**6. 一次最多3次查询**；能一条 SQL 算完别拆；明细 join 维表用复合键（system_book_code + branch_num）；配送/出库/达标率走 report_*_gen（target_id 过滤当月）。

**7. 所有消息都用 markdown 富文本，类型全覆盖不做限制**（标题/加粗/斜体/列表/表格/引用/代码/链接等）；数据结果按规则3，普通消息同。不用卡片。

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
