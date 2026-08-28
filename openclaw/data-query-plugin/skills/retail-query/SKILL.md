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
- **列**：biz_type（delivery=熊喵自营配送 / wholesale=品品甜批发 / **wholesale_ext=外部批发客户**）、sbc（**业务品牌归属**：3120=熊喵 / 64188=品品甜拿货）、**ledger_sbc（单据源账套，均为 3120）**、branch_num（门店号）、biz_date（YYYY-MM-DD）、amount（金额）、profit（毛利，**无成本权限=NULL**）、item_name（仅展示/分组，**禁止做 join 键**）、item_num（源账套 3120 编号）、pos_item_code、category（源端原始品类）、**top_category（三类归类，视图已注入——品类聚合直接用它，免 join）**、item_code。已按权限行级裁剪。
- **口径**：**门店出库 = delivery + wholesale（品品甜）**；**wholesale_ext（外部批发客户，branch_num=99）不算门店出库**——统计"出库金额/配送"时必须排除 biz_type='wholesale_ext'（或单独列示）。
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

> **★主数据 join 铁律（网关机械强制，违规直接报错不执行）**
> dim_item 是双账套表：12,209 个商品名中约 6,056 个在 3120/64188 **同名不同货**——裸 `item_name` join 会每条明细命中两行维表，整表精确 ×2。
> - **优先免 join**：品类聚合直接 GROUP BY outbound_detail 自带的 `top_category`（视图已注入主数据归类，2026-08-28 起）；
> - 确需 join dim_item 时，账套键 = **`ledger_sbc`（单据源账套）而非 sbc**——sbc 是业务品牌归属（品品甜批发 sbc=64188，但单据在 3120 账套落账、item_num 全是 3120 编号；按 sbc=64188 配档案会大面积 miss + 撞号错配，8/27 实证丢 9.6 万）：
>   `ON o.ledger_sbc = di.system_book_code AND o.item_num = di.item_num`；
> - pos_item_code/item_code 在两账套各有一行同码——**必须再配账套**：`ON o.pos_item_code = di.item_code AND o.ledger_sbc = di.system_book_code`；
> - JOIN dim_branch 同理复合键：`ON <表>.sbc = db.system_book_code AND <表>.branch_num = db.branch_num`；
> - 看到报错 `forbidden_item_join` / `forbidden_branch_join` = 违反铁律 → 改写成上述复合键，不要换个写法绕过。

规范示例——品类出库 + 毛利（免 join，直接用视图列）：
```sql
SELECT top_category, CAST(SUM(amount) AS DOUBLE) amt,
       SUM(CASE WHEN profit IS NOT NULL THEN profit ELSE NULL END) prof
FROM outbound_detail
WHERE biz_date >= '2026-08-01' AND biz_type <> 'wholesale_ext'
GROUP BY 1 ORDER BY 2 DESC;
```

**规则**：报表中心有的指标/看板 → 用 ①-⑧ 模板（同口径，禁止明细自行聚合）；只有模板没有的自由维度 → 才用 ⑨。

## 回答规则（简短，严格遵守）

**1. 数据只来自 query_retail_data 返回**，绝不编造；工具没调/报错/空/无权限 → 如实说查不到。

**2. 排行列 Top N（默认10）**；成本列无权限 = NULL 别当 0；日期写清是哪天；金额 ≥1万 用「X.X 万」。

**3. 数据结果（排行/汇总/统计）→ markdown 富文本，类型不限**（标题/加粗/斜体/有序无序列表/表格/引用/代码/链接等都用上）：排行用 `## 标题` + `| 排名 | 门店 | 金额 |` 表格 + `**合计**` 加粗 + 口径说明。展示清楚、好看即可，不做限制。

**4. 语义不明（多个口径可选）→ 用文字列出选项问用户**（如「要哪个口径？回复：1 门店销售 / 2 区域 / 3 商品」），用户回复后按所选查询。不用卡片。

**5. 成本/权限预检**：每次查询返回的 perms.branch_nums 即可见门店；空=无权限直接说；涉及战区先查 report_region_breakdown_gen 的 war_zone 确认可见范围，目标不在 → 直接说查不到，不反复验证。

**6. 一次最多3次查询**；能一条 SQL 算完别拆；明细 join 维表用复合键（dim_branch = sbc+branch_num；dim_item = sbc+item_num 或 pos_item_code/item_code，见上方★铁律）；配送/出库/达标率走 report_*_gen（target_id 过滤当月）。

**7.5 权限披露约束（数据保护）**：
- **不主动披露权限外门店的存在**：查询中发现的权限外门店，不列举店名/店号/战区，只说「该店不在你的可见范围」。
- **必须提及门店时**：只用**文字店名**（如「品品甜大理下关2店」），**不要**用门店编号（64188-0090）/sbc/复合键。
- **不透露内部表名**：回答中不出现 transfer_detail / wholesale_detail / outbound_detail / retail_detail 等内部表名，统一用业务叫法（「出库明细」「配送数据」「销售明细」）。
- 权限内数据正常回答；权限外一律「不在可见范围」，不给出其任何信息。

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

## 配送明细（outbound_detail 的 delivery 分量）

用户问"配送/调出/中心发了多少货给某店/配送毛利"→ 查 `outbound_detail` 的 `biz_type='delivery'` 分量（熊喵自营配送，只 3120）：
- **门店配送额** `SUM(amount)`、**配送毛利** `SUM(profit)`；按日过滤 `biz_date`、按门店 `sbc+branch_num`。
- 独立的 delivery_detail 数据集已从字典下架（网关未构建该视图，查询会被拒）；**不要尝试直查它**。
- 更细的单号/数量字段合并视图未暴露——被问到时如实说「可查到金额与毛利粒度」，绝不编造。

## 批发明细（outbound_detail 的 wholesale 分量）

用户问"批发/批发销售/批发毛利/品品甜拿货"→ 查 `outbound_detail` 批发分量：
- **品品甜经供应链批发**：`biz_type='wholesale'`（sbc='64188'，client_name 已映射成门店号）；**外部批发客户** `biz_type='wholesale_ext'`（branch_num='99'）——统计门店出库口径时必须排除它。
- 目标视角的**客户级批发汇总**走模板⑤ `report_wholesale_daily_gen`；合并视图本身没有客户列，别造 client 字段。
- 独立的 wholesale_detail 数据集已从字典下架（同上），一律走 outbound_detail。

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
