# 数据字典 / 表结构说明

> 数据分析平台的库表全景：每张表的用途、字段、来源、JOIN 键、注意事项。
> 生成依据：`datasets` + `dataset_columns`（采集时注册的列语义）+ PG `information_schema`（实际列类型）。

---

## 0. 全景速览

### 数据流

```
乐檬 API → 采集 → {S3 parquet（明细 fact）+ PG（维度 dim + 聚合 summary）}
                         ↓ DuckDB 读 parquet 聚合（/compute）
                    PG report_daily_*（summary）
                         ↓ PostgREST / 报表中心 / 语义层
                      前端 / admin / AI 问数
```

### 表分类与存储

| 类 | 表数 | 存哪 | 怎么查 |
|---|---|---|---|
| **明细 fact** | 3 | S3 parquet（`engine=duckdb_view`） | DuckDB `read_parquet('s3://...')` |
| **维度 dim** | 5 | PG + parquet 双份 | psql / PostgREST（PG）；DuckDB（parquet） |
| **聚合 summary** | 5 表 + 5 视图 | PG（`engine=pg_table`） | psql / PostgREST |
| **目标 targets** | 2 | PG | psql |
| **语义层** | 4 | PG | psql / `/admin/semantic` |

### 通用约定

- **明细列全是 VARCHAR**（乐檬原样落库）：数学运算前必须 `CAST(... AS DOUBLE/NUMERIC)`
- **品牌编码**：`3120` = 鲜果恰恰（零售+批发+配送）、`64188` = （零售为主）
- **JOIN 键品牌隔离**：`branch_num` / `item_num` 是品牌内编号，跨表 JOIN 必须带 `system_book_code`（PK 多为 `(system_book_code, xxx)`）；`item_code` 是跨品牌合并键
- 🔒 = 成本敏感字段：`can_see_cost=false` 时查到 NULL（PostgREST view builder 脱敏）
- 🔑 = JOIN 键

---

## 1. 明细表（fact，3 张）

存 S3 parquet，路径 `s3://lemeng-datasource/lemeng/<type>/*/*/all.parquet`。DuckDB 读。

### 1.1 `retail_detail` — 零售销售明细（46 列）

> 门店零售销售（销售订单的商品行）。粒度=订单明细行。采集：`collect-lemeng`（3120+64188）。日期过滤用 `order_detail_bizday`（YYYYMMDD）。

| 列 | 类型 | 说明 |
|---|---|---|
| order_no | VARCHAR | 订单号 |
| order_detail_num | VARCHAR | 明细号 |
| order_time | VARCHAR | 下单时间 YYYY-MM-DD HH:MM:SS |
| **order_detail_bizday** | VARCHAR | 🔑 业务日 YYYYMMDD（按日过滤） |
| order_sale_channel / order_sale_type / state | VARCHAR | 渠道/类型/状态 |
| **branch_num** | VARCHAR | 🔑 门店号（→ dim_branch） |
| branch_code / branch_name | VARCHAR | 门店编码/名 |
| **item_num** | VARCHAR | 🔑 商品号（→ dim_item） |
| **item_code** | VARCHAR | 🔑 商品业务码（→ canonical_product，跨品牌） |
| item_name / item_category / item_spec / item_unit / department | VARCHAR | 商品属性 |
| item_regular_price | VARCHAR | 正常售价 |
| supplier_num / supplier_name / supplier_code | VARCHAR | 供应商 |
| **sale_money** | VARCHAR | 销售金额（sale_amount 指标源） |
| discount_money / payment_receipt_money / order_detail_price / total_amount / tax_money | VARCHAR | 折扣/收款/单价/总额/税 |
| discount_rate / overall_discount_rate | VARCHAR | 折扣率 |
| management_style_type / order_payee / order_sold_by | VARCHAR | 经营方式/收款人/销售员 |
| 🔒 item_cost_price / order_detail_cost / order_detail_grade_cost / cost / **profit** / sale_profit_rate | VARCHAR | 成本/利润（无权限=NULL） |

### 1.2 `wholesale_detail` — 批发销售明细（36 列）

> 批发销售（给批发客户）。粒度=批发单明细行。采集：`collect-wholesale`（仅 3120）。日期过滤用 `audit_time`（审核时间）。

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR | 明细行唯一 id（去重键） |
| pos_order_num / pos_order_type | VARCHAR | 批发单号/类型 |
| **audit_time** | VARCHAR | 🔑 审核时间 YYYY-MM-DD HH:MM:SS（按日过滤） |
| sale_time | VARCHAR | 销售时间 |
| order_type / settlement_status | VARCHAR | 订单类型/结算状态 |
| **branch_num** | VARCHAR | 🔑 销售门店号（→ dim_branch） |
| **client_code** / client_name | VARCHAR | 🔑 批发客户号/名（→ dim_customer） |
| storehouse_num / storehouse_name | VARCHAR | 仓库 |
| **item_num** | VARCHAR | 🔑 商品号（→ dim_item） |
| **pos_item_code** | VARCHAR | 🔑 商品业务码（→ canonical_product） |
| pos_item_name / pos_item_category(_name) / pos_item_bar_code / department / spec / unit | VARCHAR | 商品属性 |
| lot_number | VARCHAR | 批次号 |
| wholesale_num | VARCHAR | 批发数量 |
| **wholesale_money** | VARCHAR | 批发金额（wholesale_amount 指标源） |
| wholesale_unit_price | VARCHAR | 批发单价 |
| 🔒 wholesale_cost / **wholesale_profit** | VARCHAR | 批发成本/毛利（无权限=NULL） |
| no_tax_money / no_tax_unit_price / tax_money / tax_rate | VARCHAR | 不含税/税 |
| wholesale_return_num / wholesale_replenishment_money | VARCHAR | 退货数/补货额 |
| order_maker / order_seller / order_auditor | VARCHAR | 制单/销售/审核 |

### 1.3 `delivery_detail` — 配送调出明细（36 列）

> 门店间配送/调拨（transfer）。粒度=调出单明细行。采集：`collect-delivery`（仅 3120，调出方=配送中心99）。日期过滤用 `order_time`。注意：**这是配送中心→门店，不是门店→批发客户**。

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR | 明细行唯一 id（去重键） |
| pos_order_num / pos_order_type | VARCHAR | 调出单号/类型 |
| **order_time** | VARCHAR | 🔑 调出业务日 YYYY-MM-DD HH:MM:SS（按日过滤） |
| sale_time / state | VARCHAR | 调出时间/状态 |
| distribution_branch_num / distribution_branch_name | VARCHAR | 调出方（配送中心=99） |
| **response_branch_num** | VARCHAR | 🔑 调入门店号（→ dim_branch，按店算拿货量） |
| response_branch_name / response_branch_region_name | VARCHAR | 调入门店名/战区 |
| storehouse_num / storehouse_name | VARCHAR | 仓库 |
| **item_num** | VARCHAR | 🔑 商品号（→ dim_item） |
| **pos_item_code** | VARCHAR | 🔑 商品业务码（→ canonical_product） |
| pos_item_name / item_category / top_category_name / department / item_method / spec / out_unit | VARCHAR | 商品属性 |
| lot_number | VARCHAR | 批次号 |
| out_amount | VARCHAR | 调出数量（拿货量，可负=退货） |
| **out_money** | VARCHAR | 调出金额（delivery_amount 指标源） |
| out_unit_price | VARCHAR | 调出单价 |
| 🔒 cost_price / cost_unit_price / **profit_money** | VARCHAR | 成本/毛利（无权限=NULL） |
| no_tax_out_money / tax_money / base_amount / base_price | VARCHAR | 不含税/税/基本单位 |
| order_maker / order_seller / order_auditor | VARCHAR | 制单/销售/审核 |

---

## 2. 维度表（dim，5 张）

### 2.1 `dim_branch` — 门店（22 列，PG + parquet）

> 门店主数据。采集：`collect-branches`（3120+64188）。PK `(system_book_code, branch_num)`。`is_active` 软删除。**两品牌共享 branch_num**（同物理门店），跨表 JOIN 须带 system_book_code。

| 列 | 类型 | 说明 |
|---|---|---|
| **system_book_code** | TEXT | 品牌（PK 一部分） |
| **branch_num** | TEXT | 🔑 门店号（API system_id，PK 一部分） |
| branch_id / branch_code / branch_name | TEXT | 系统 id/编码/名 |
| region_name | TEXT | 区域名（如"东部二区"） |
| **first_level_region** | TEXT | 一级战区（考核白名单用 is_assessed_war_zone） |
| **second_level_region** | TEXT | 二级小区 |
| branch_groups | TEXT | 多级标签 |
| province / city / district / address / phone | TEXT | 地理/联系 |
| longitude / latitude | TEXT | 经纬度 |
| enable / deleted / expire_time | | 乐檬启停 |
| **is_active** | BOOLEAN | 软删除（采集未见→false） |
| raw | JSONB | API 原始 |
| updated_at | TIMESTAMP | |

> 配套：`dim_branch_ext`（人工维护 custom_group/note，采集不碰）、`branch_full` 视图（JOIN dim_region 取 war_zone）。

### 2.2 `dim_item` — 商品（19 列，PG + parquet）

> 商品主数据。采集：`collect-items`（3120+64188）。PK `(system_book_code, item_num)`。

| 列 | 类型 | 说明 |
|---|---|---|
| **system_book_code** | TEXT | 品牌 |
| **item_num** | TEXT | 🔑 商品号（品牌内，PK） |
| **item_code** | TEXT | 🔑 跨品牌合并键（→ canonical_product） |
| bar_code / item_name | TEXT | 条码/名 |
| category_code / category_name / category_path / **top_category** | TEXT | 品类层级 |
| item_brand / department / item_unit / item_regular_price | TEXT | 品牌/部门/单位/售价 |
| 🔒 item_cost_price | TEXT | 成本价（can_see_cost=false→NULL） |
| supplier_name / item_tags | TEXT | 供应商/标签 |
| is_active | BOOLEAN | 软删除 |

> 配套：`dim_item_ext`（人工维护）。

### 2.3 `dim_customer` — 批发客户（9 列，PG，A4 派生）

> 从 wholesale_detail parquet 派生（乐檬无客户档案 API）。PK `(system_book_code, client_code)`。`/derive-dim-customer` 日 cron（04:20）。仅 3120（批发只 3120）。

| 列 | 类型 | 说明 |
|---|---|---|
| **system_book_code** | TEXT | 品牌（=3120） |
| **client_code** | TEXT | 🔑 批发客户号（PK） |
| client_name | TEXT | 最近客户名（arg_max by audit_time） |
| first_order_date / last_order_date | DATE | 首单/末单 |
| active_days | INT | 活跃天数 |
| **is_active** | BOOLEAN | 软删除 |
| raw | JSONB | |
| updated_at | TIMESTAMP | |

> 配套：`dim_customer_ext`（人工 custom_group/note）、`customer_full` 视图。

### 2.4 `dim_region` — 战区（5 列，PG + parquet）

> 统一战区维表（品牌无关）。PK `region_name`。`war_zone` 留空→走 `derive_war_zone(region_name)` 自动派生（前缀规则），填了则覆盖。

| 列 | 类型 | 说明 |
|---|---|---|
| **region_name** | TEXT | 区域名（PK，两品牌共享） |
| war_zone | TEXT | 战区（空→自动派生） |
| sub_region | TEXT | 小区 |
| display_name | TEXT | 显示名 |
| updated_at | TIMESTAMP | |

### 2.5 `canonical_product` — 标品（7 列，PG）

> 跨品牌商品合并（item_code 合并键，把 3120/64188 同商品归一）。

| 列 | 类型 | 说明 |
|---|---|---|
| **item_code** | TEXT | 🔑 跨品牌合并键 |
| display_name | TEXT | 展示名 |
| category_name / **top_category** | TEXT | 品类 |
| brand_count | BIGINT | 覆盖品牌数 |
| brands | TEXT[] | 品牌列表 |
| is_active_any | BOOLEAN | 任一品牌在售 |

---

## 3. 聚合表（summary，PG）

> DuckDB `/compute` 从明细 parquet 聚合写入。粒度见各表 PK。

### 3.1 `report_daily_sales` — 日销售（10 列）

> 粒度 `(biz_date, system_book_code, branch_num)`。源 retail_detail。

| 列 | 类型 | 说明 |
|---|---|---|
| **biz_date** | DATE | 业务日 |
| **system_book_code** | TEXT | 品牌 |
| **branch_num** | VARCHAR | 门店 |
| branch_name | VARCHAR | 门店名 |
| total_orders / total_items | INTEGER | 订单数/件数 |
| **total_sale** | NUMERIC(12,2) | 销售额（sale_amount 源列） |
| 🔒 total_profit | NUMERIC(12,2) | 利润（sale_profit 源列） |
| created_at / updated_at | TIMESTAMP | |

> `report_daily_sales_v`：脱敏视图（can_see_cost=false→profit NULL）。

### 3.2 `report_daily_delivery` — 日配送（8 列）

> 粒度 `(biz_date, system_book_code, branch_num, category_group)`。源 delivery_detail。**仅 3120 数据**。

| 列 | 类型 | 说明 |
|---|---|---|
| **biz_date / system_book_code / branch_num / category_group** | | PK（category_group=水果/标品耗材/其他） |
| **out_money** | NUMERIC | 配送金额（delivery_amount 源列） |
| 🔒 profit_money | NUMERIC | 配送毛利（delivery_profit 源列） |
| created_at / updated_at | TIMESTAMP | |

### 3.3 `report_daily_wholesale` — 日批发（8 列）

> 粒度 `(biz_date, system_book_code, branch_num, category_group)`。源 wholesale_detail。

| 列 | 类型 | 说明 |
|---|---|---|
| **biz_date / system_book_code / branch_num / category_group** | | PK |
| **wholesale_money** | NUMERIC | 批发金额（wholesale_amount 源列） |
| 🔒 wholesale_profit | NUMERIC | 批发毛利（wholesale_profit 源列） |
| created_at / updated_at | TIMESTAMP | |

### 3.4 `report_daily_category` — 日品类（9 列）

> 粒度 `(biz_date, system_book_code, branch_num, category)`。源 retail_detail。

| 列 | 类型 | 说明 |
|---|---|---|
| **biz_date / system_book_code / branch_num / category** | | PK |
| total_items | INTEGER | 件数 |
| total_sale | NUMERIC | 销售额 |
| 🔒 total_profit | NUMERIC | 利润 |

### 3.5 `report_weekly_trend` — 周趋势（9 列）

> 粒度 `(week_start, system_book_code, branch_num)`。滚动 8 周。

| 列 | 类型 | 说明 |
|---|---|---|
| **week_start / system_book_code / branch_num** | | PK |
| branch_name | VARCHAR | |
| total_sale | NUMERIC | 本周销售 |
| prev_week_sale | NUMERIC | 上周销售 |
| growth_rate | NUMERIC(5,2) | 环比 |

---

## 4. 报表视图（PG）

| 视图 | 列数 | 说明 |
|---|---|---|
| `report_daily_sales_v` | 8 | 销售脱敏视图（profit 按 can_see_cost） |
| `report_daily_category_v` | 7 | 品类脱敏视图 |
| `report_region_breakdown_v` | 19 | **目标下钻**（target×战区/小区/门店，sale/delivery 的 target/actual/rate/日均）；⚠️ 有 ALL target 重复计算 bug |
| `report_category_summary_v` | 13 | 目标品类汇总（sale/profit target/actual/rate/margin/日均） |
| `report_achievement_v` | 31 | 目标达成总览（target×指标，actual/rate/progress/data_status） |
| `report_store_sales_drill_v` | 8 | **语义层生成**（A2，level/parent_code/target_id/code/name + sale_amount/profit/margin）；audit 视图配套 |

---

## 5. 目标表（PG）

### 5.1 `targets`（19 列）

| 关键列 | 说明 |
|---|---|
| **id** | 目标 PK |
| name / status（active/closed） | 名称/状态 |
| system_book_code | 品牌（或 'ALL' 总部） |
| branch_num / war_zone / region_l2 | 范围 |
| start_date / end_date | 周期 |
| target_level（total/breakdown）/ breakdown_level（store/...） | 层级 |
| target_type / category | 类型/品类 |
| parent_target_id | 父目标 |

### 5.2 `target_metric_values`

| 列 | 说明 |
|---|---|
| **target_id + metric_code** | PK |
| target_value | 目标值（metric=sale/delivery 等） |

---

## 6. 语义层表（PG，A1-A4）

| 表 | 说明 |
|---|---|
| `metric_registry` | 9 指标定义（base/derived、formula、depends_on、additive、cost_sensitive、unit） |
| `metric_sources` | 指标→聚合表+列映射（source_table/source_column/source_filter）⚠️ source_filter 当前硬编码 '64188'（校准发现：致 delivery 查空、销售/批发漏 3120） |
| `dimensions` | 维度定义（branch/item/customer，static/derived，join_table/join_key） |
| `dimension_levels` | 维度层级（branch 三级 region/sub_region/store，item/customer 单层） |
| `semantic_dictionary_v` | 字典视图（指标+维度 UNION，admin 字典 Tab 数据源） |
| `validate_semantic_registry()` | 配置校验函数（base 定位/derived 依赖/维度 join_key） |

---

## 7. 附录

### 7.1 JOIN 键关系

```
retail_detail / wholesale_detail / delivery_detail
   ├── branch_num + system_book_code ──→ dim_branch
   ├── item_num  + system_book_code ──→ dim_item
   ├── item_code ──→ canonical_product（跨品牌）
   └── client_code（wholesale） + system_book_code ──→ dim_customer

dim_branch.region_name ──→ dim_region → war_zone
report_daily_* ← /compute 聚合自明细 parquet
report_*_v ← PostgREST 脱敏视图（can_see_cost）
```

### 7.2 品牌编码

- `3120` 鲜果恰恰：零售 + 批发 + 配送（全业务）
- `64188`：零售为主（无批发/配送明细）

### 7.3 数据完整性（CLAUDE.md 规则）

- 明细采集按维度对账（库内 active ≥ 源 total）
- 软删除：维度 is_active（采集未见→false）
- 加表/加列后须 `docker compose restart postgrest` 刷 schema 缓存
- 成本敏感字段：anon/无权限查 _v 视图得 NULL

### 7.4 校准发现（2026-07）

- 🔴 `metric_sources.source_filter` 硬编码 '64188'：delivery（只 3120）查空、sale/wholesale 漏 3120（待修：改 NULL，品牌由 target_scoped JOIN 按 target 限）
- 🔴 `report_region_breakdown_v` 对 ALL target 重复计算 3.6 倍（branch_dim 未按品牌去重，待修）
