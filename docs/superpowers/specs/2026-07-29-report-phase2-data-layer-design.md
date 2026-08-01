# 报表 Phase 2 数据层（商品/客户级聚合）设计

**日期**：2026-07-29
**状态**：已确认，待实现
**前置**：门店键改革（branch_number/复合键）、collect-branches/collect-delivery/collect-wholesale 已 cron、scheduler C1（采集后自动 /compute）
**关联**：`docs/superpowers/specs/2026-07-21-report-center-redesign-design.md`（Phase 2 报表）、`2026-07-28-store-brand-dimension-reform-design.md`（品牌归属）

---

## 1. 背景与目标

### 1.1 现状缺口

`report_daily_sales/delivery/wholesale` 三表粒度被聚合到 **(biz_date, system_book_code, branch_num, category_group)**，**丢了 item_num 和 client_code**。而报表 Phase 2 需要商品级和客户级数据：

- **品牌×指标表的品品甜配送列**：品品甜(64188)是熊喵外部客户，配送走批发明细 client_name→品品甜门店，report_daily_wholesale 无 client。
- **销售商品 TOP20 / 出库商品 TOP20**：需 item_num 聚合（TOP20 + 占比）。
- **批发客户出库下钻**：需 client_code 聚合（日期→客户）。

### 1.2 目标

建 3 张 item/customer 级聚合表 + /compute 任务（加进 C1 自动链），一次性解锁上述全部报表板块。商品/客户级数据只在原始明细 parquet 有 → 必须新聚合表（不能从现有 report_daily_* 派生）。

---

## 2. 三张聚合表

### 2.1 report_daily_item_sales（销售商品级）

```sql
CREATE TABLE IF NOT EXISTS report_daily_item_sales (
  biz_date        DATE NOT NULL,
  system_book_code TEXT NOT NULL,      -- 品牌(3120熊喵/64188品品甜)，从 parquet 路径 regexp_extract
  item_num        TEXT NOT NULL,
  sale_amount     DECIMAL(14,2) DEFAULT 0,   -- Σ sale_money
  sale_profit     DECIMAL(14,2) DEFAULT 0,   -- Σ profit（成本敏感，报表层脱敏）
  updated_at      TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
```
- 源：`retail_detail` parquet
- /compute 模板（照 daily_sales 范式）：`read_parquet(filename=true)` + `regexp_extract(filename,'retail_detail/([0-9]+)/',1) AS system_book_code` + GROUP BY biz_date(raw), sbc, item_num + SUM(sale_money), SUM(profit)
- date_column：`order_detail_bizday`（YYYYMMDD）
- conflict_keys：`["biz_date","system_book_code","item_num"]`

### 2.2 report_daily_item_outbound（出库商品级，delivery+wholesale 合表）

```sql
CREATE TABLE IF NOT EXISTS report_daily_item_outbound (
  biz_date        DATE NOT NULL,
  system_book_code TEXT NOT NULL,
  item_num        TEXT NOT NULL,
  delivery_amount  DECIMAL(14,2) DEFAULT 0,   -- transfer_detail Σ out_money
  delivery_profit  DECIMAL(14,2) DEFAULT 0,   -- transfer_detail Σ profit_money（成本敏感）
  wholesale_amount DECIMAL(14,2) DEFAULT 0,   -- wholesale_detail Σ wholesale_money
  wholesale_profit DECIMAL(14,2) DEFAULT 0,   -- wholesale_detail Σ wholesale_profit（成本敏感）
  updated_at      TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
```
- 源：`transfer_detail` ∪ `wholesale_detail` 两 parquet
- /compute 模板：CTE 各自按 (sbc, biz_date, item_num) 聚合，`FULL OUTER JOIN` 合并（delivery 左、wholesale 右，COALESCE 补 0）。一个 SELECT（WITH…SELECT），/compute 单任务执行。
  - transfer sbc 路径：`transfer_detail/([0-9]+)/`，日期 `order_time`（substr 拼 YYYYMMDD）
  - wholesale sbc 路径：`wholesale_detail/([0-9]+)/`，日期 `audit_time`
- date_column：以 transfer 的 order_time 为 date_column（wholesale 用 audit_time 在 CTE 内独立处理）；date_format YYYYMMDD
- conflict_keys：`["biz_date","system_book_code","item_num"]`
- 视图层（后续）：`outbound_amount = delivery_amount + wholesale_amount`，`outbound_profit = delivery_profit + wholesale_profit`

### 2.3 report_daily_wholesale_customer（批发客户级）

```sql
CREATE TABLE IF NOT EXISTS report_daily_wholesale_customer (
  biz_date        DATE NOT NULL,
  system_book_code TEXT NOT NULL,
  client_code     TEXT NOT NULL,             -- wholesale_detail client_code
  client_name     TEXT,                      -- MAX(client_name)
  branch_num      TEXT,                      -- wholesale 行 branch_num（发货方/配送中心，区分门店调拨 vs 外部批发）
  wholesale_amount  DECIMAL(14,2) DEFAULT 0,
  wholesale_profit  DECIMAL(14,2) DEFAULT 0,  -- 成本敏感
  updated_at      TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, client_code)
);
```
- 源：`wholesale_detail` parquet
- /compute 模板：GROUP BY sbc(path), biz_date(audit_time), client_code + SUM(wholesale_money/wholesale_profit) + MAX(client_name/branch_num)
- date_column：`audit_time`（YYYYMMDD）
- conflict_keys：`["biz_date","system_book_code","client_code"]`
- 品牌表品品甜配送来源：此表 client_name→品品甜门店(64188 dim_branch.branch_name) 映射（066 口径），视图层处理

---

## 3. /compute 任务（report_definitions）

3 个新 report_type 插入 `report_definitions`（照 010 daily_sales 范式）：`item_sales` / `item_outbound` / `wholesale_customer`。各含 `sql_template`（read_parquet，占位符 `{{source_pattern}}/{{date_column}}/{{date_from_compact}}/{{date_to_compact}}`）、`field_mapping`（含 `biz_date_raw→biz_date` YYYYMMDD 转 YYYY-MM-DD）、`conflict_keys`。

> item_outbound 的 source_pattern：单模板读两个 parquet 路径（transfer_detail + wholesale_detail），用 CTE 各读其一。

---

## 4. C1 自动化（加进 scheduler triggerCompute）

`web/lib/scheduler.ts` 的 `triggerCompute()` reports 数组（line 152-158）追加 3 项：
```ts
{ type: "item_sales",          dateFrom: dates[0], dateTo: dates[1] },
{ type: "item_outbound",       dateFrom: dates[0], dateTo: dates[1] },
{ type: "wholesale_customer",  dateFrom: dates[0], dateTo: dates[1] },
```
采集 verified 后自动 /compute（同现有 5 张表节奏），失败记 compute_logs + 企微告警。**零手动、零陈旧风险**。

---

## 5. 完整性方案（CLAUDE.md 五点，逐表）

每个 /compute 任务须满足：
1. **按维度对账**：/compute 返回的聚合行数 ≥ parquet distinct(sbc,item_num/client_code,biz_date) 数（service 端 count 校验，照 collect-branches 范式）。
2. **拉取完整**：日期范围全扫（`{{date_column}} BETWEEN from AND to`），不满页/断页不丢（read_parquet 一次性读全，无分页问题）。
3. **写入失败检测**：upsert 失败行计入 `compute_logs.error`；`verified = 全扫 && 无 upsert 失败 && 行数≥对账`。
4. **陈旧数据处理**：/compute 先清该日期范围旧行（`DELETE WHERE biz_date BETWEEN from AND to`，services/server.js 已有此逻辑 line 567）再写 → 天然覆盖，无 stale 残留。
5. **失败→告警**：compute_logs status=failed → 企微告警（triggerCompute 已有 line 184 notifyWecom）。

> 关联坑：加表/加列后 `docker compose restart postgrest` 刷 schema 缓存（GHA 不保证）；migrate 重跑全部迁移，视图用 DROP+CREATE。

---

## 6. 品牌级 RLS + 成本脱敏

三表粒度 (品牌, 商品/客户)，无 branch_num，现有 branch_nums RLS 不适用。

**行级（品牌可见）**：RLS policy 按 `system_book_code IN (用户 branch_nums 所属品牌)`：
```sql
-- claim branch_nums=['*'] 或 NULL → 全量；否则限用户门店所属品牌
current_setting('request.jwt.claims.branch_nums', true) IS NULL
 OR (current_setting(...))::jsonb ? '*'
 OR system_book_code IN (
   SELECT DISTINCT d.system_book_code FROM dim_branch d
   WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting(...))::jsonb))
 )
```
照搬 `report_daily_delivery` 的 RLS 模式（替换 branch_num→品牌派生）。

**列级（成本脱敏）**：profit 列（sale_profit/delivery_profit/wholesale_profit）在**报表视图层**按 `can_see_cost` claim 用 CASE 脱敏（照 report_achievement_v 模式），基表存全值。

---

## 7. 口径对齐

- 出库 = delivery + wholesale（视图层合成，水果/标品耗材品类口径在视图 join dim_item 算）
- 配送(品品甜) = wholesale client_name→64188 门店（066 映射）
- margin/profit 用 API 原值，不反算（照 data-reconcile-guard）
- 当天定义 = 目标窗口内今日（照 region_breakdown_v）
- 成本敏感：sale_profit/wholesale_profit 视图层 can_see_cost gating

---

## 8. 架构影响

- 新增 3 张 PG 聚合表（report_daily_item_sales/item_outbound/wholesale_customer）+ 3 个 report_definitions + C1 链 3 项 + 3 个 RLS policy。
- 数据流：采集(cron) → parquet → C1 triggerCompute → /compute(DuckDB read_parquet 聚合) → UPSERT PG → 报表视图查询（带品牌 RLS + 成本脱敏）。
- 更新 `docs/architecture.md` §报表体系（新增 item/customer 级聚合层）。
- 属架构变更，按 CLAUDE.md 先 spec（本文件）→ 用户确认 → 更新 architecture.md → 实现。

---

## 9. 风险与 YAGNI

### 风险
1. **item_outbound 双源 CTE 模板**：read_parquet 两路径 + FULL JOIN，DuckDB 性能/正确性须实测（/compute 单次验证行数）。
2. **wholesale customer→品品甜门店映射**：client_name 与 dim_branch.branch_name 匹配率（066 已验证可映射）；未匹配 client = 外部批发客户。
3. **parquet 利润成本敏感**：采集 token 须有成本权限才能拿到非 NULL profit（现有采集已具备）。
4. **schema 缓存**：加表/视图后 restart postgrest。

### 不做（YAGNI）
- 不在本 spec 建报表视图（品牌表/TOP20/下钻）—— 那是 step 1/2，依赖本数据层，单独 spec。
- 不复用 report_daily_wholesale 反推客户（粒度已丢，必须新表）。
- 不上独立 cron（C1 自动链已够）。
- 不做预警机制（Phase 4）。
