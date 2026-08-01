# 报表 Phase 2 数据层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** 建 3 张 item/customer 级聚合表 + /compute 任务（加进 C1 自动链），解锁品牌表品品甜配送 + Phase 2 报表（商品 TOP20/出库下钻/批发客户）。

**Architecture:** 采集(cron)→parquet→scheduler C1 `triggerCompute()`→/compute(DuckDB read_parquet 聚合)→UPSERT PG（DELETE-before-INSERT 清旧）→报表视图查询（品牌 RLS + 成本脱敏）。3 新表粒度 (品牌×商品/客户×日)，brand 从 parquet 路径 regexp_extract。

**Tech Stack:** PostgreSQL 15、DuckDB（services/server.js /compute）、node-cron scheduler、PostgREST RPC。

## Global Constraints

- **门店/品牌键**：`system_book_code`=品牌(3120熊喵/64188品品甜)，从 parquet 路径 `regexp_extract(filename,'xxx_detail/([0-9]+)/',1)` 取；`branch_num` 跨账套非唯一，禁止单独 join/去重（[[门店键铁律]]）。
- **迁移幂等**：`CREATE TABLE IF NOT EXISTS` + `ON CONFLICT` + `CREATE POLICY IF NOT EXISTS`（DROP IF EXISTS 兜底）；视图 `DROP+CREATE`。加表/视图后须 `docker compose restart postgrest`（GHA 不保证）。
- **完整性（CLAUDE.md 五点）**：/compute 全扫日期范围 + DELETE 清旧覆盖 + upsert 失败计入 + 行数对账 + 失败→compute_logs/企微告警（triggerCompute 已具）。
- **成本敏感**：profit 列基表存全值，**报表视图层**按 `can_see_cost` CASE 脱敏（基表不做列级脱敏）。
- **口径**：出库=delivery+wholesale（视图合成）；margin 原值不反算；当天=窗口内今日。
- **部署**：改 `database/`+`web/` → GHA 全量。
- 测试层：DB 迁移=本地 apply + SQL 验证 + restart postgrest；/compute=prod 触发验证（duckdb:9000 内网，经 web 容器调）。

**Spec:** `docs/superpowers/specs/2026-07-29-report-phase2-data-layer-design.md`

---

## File Structure

- `database/migrations/107_report_item_customer_tables.sql` — 3 表 + 索引 + 品牌 RLS
- `database/migrations/108_report_item_customer_compute_defs.sql` — 3 report_definitions（sql_template/field_mapping/conflict_keys）
- `web/lib/scheduler.ts` — triggerCompute reports 数组 +3
- `docs/architecture.md` — §报表体系 加 item/customer 聚合层

---

### Task 1: 3 张聚合表 + 索引 + 品牌 RLS

**Files:** Create `database/migrations/107_report_item_customer_tables.sql`
**Interfaces:** Produces `report_daily_item_sales` / `report_daily_item_outbound` / `report_daily_wholesale_customer`（Task 2 /compute 写入、Task 5 验证、后续报表视图查询）。

- [ ] **Step 1: 写迁移 107**

```sql
-- 107_report_item_customer_tables.sql
-- 报表 Phase 2 数据层：商品/客户级聚合表（解锁品牌表品品甜配送 + 商品TOP20 + 批发客户下钻）
-- 粒度 (biz_date, system_book_code, item_num/client_code)；brand 从 parquet 路径取，/compute 聚合写入
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT + DROP/CREATE POLICY；部署后 restart postgrest

-- 1. 销售商品级
CREATE TABLE IF NOT EXISTS report_daily_item_sales (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, item_num TEXT NOT NULL,
  sale_amount DECIMAL(14,2) DEFAULT 0, sale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
-- 2. 出库商品级（delivery+wholesale 合表）
CREATE TABLE IF NOT EXISTS report_daily_item_outbound (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, item_num TEXT NOT NULL,
  delivery_amount DECIMAL(14,2) DEFAULT 0, delivery_profit DECIMAL(14,2) DEFAULT 0,
  wholesale_amount DECIMAL(14,2) DEFAULT 0, wholesale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
-- 3. 批发客户级
CREATE TABLE IF NOT EXISTS report_daily_wholesale_customer (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, client_code TEXT NOT NULL,
  client_name TEXT, branch_num TEXT,
  wholesale_amount DECIMAL(14,2) DEFAULT 0, wholesale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, client_code)
);
CREATE INDEX IF NOT EXISTS idx_rdis_sbc_date ON report_daily_item_sales(system_book_code, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdio_sbc_date ON report_daily_item_outbound(system_book_code, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdwc_sbc_date ON report_daily_wholesale_customer(system_book_code, biz_date);

-- 品牌 RLS（claim branch_nums=['*']或NULL→全量；否则限用户门店所属品牌）。照 report_daily_delivery 模式派生品牌。
-- item_sales
DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_sales;
CREATE POLICY report_rls_brand ON report_daily_item_sales FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
-- item_outbound（同上 policy）
DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_outbound;
CREATE POLICY report_rls_brand ON report_daily_item_outbound FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
-- wholesale_customer（同上 policy）
DROP POLICY IF EXISTS report_rls_brand ON report_daily_wholesale_customer;
CREATE POLICY report_rls_brand ON report_daily_wholesale_customer FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
GRANT SELECT ON report_daily_item_sales, report_daily_item_outbound, report_daily_wholesale_customer TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 107: item/customer 聚合表 3 张 + 品牌 RLS'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/107_report_item_customer_tables.sql
docker restart deploy-postgrest-1; sleep 5
```
- [ ] **Step 3: 验证表 + RLS（service 全量、claim 限品牌）**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d report_daily_item_sales"
# RLS 启用 + policy 在
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT relrowsecurity, count(*) FROM pg_policy WHERE polrelid IN ('report_daily_item_sales'::regclass,'report_daily_item_outbound'::regclass,'report_daily_wholesale_customer'::regclass) GROUP BY 1;"
```
Expected: 3 表建成；每表 1 条 report_rls_brand policy。
- [ ] **Step 4: Commit**
```bash
git add database/migrations/107_report_item_customer_tables.sql
git commit -m "feat(db): report_daily_item_sales/item_outbound/wholesale_customer 3 表 + 品牌 RLS"
```

---

### Task 2: 3 个 report_definitions（sql_template + field_mapping）

**Files:** Create `database/migrations/108_report_item_customer_compute_defs.sql`
**Interfaces:** Produces report_definitions 行 `item_sales`/`item_outbound`/`wholesale_customer`（/compute 引擎读取执行 → 写 Task 1 表；scheduler Task 3 触发）。
**Pre-check:** wholesale_detail.client_code 是否可roup（多数非空）；若稀疏，grain 退 client_name（调整 PK + conflict_keys + template GROUP BY）。先查：
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) FILTER (WHERE client_code IS NOT NULL AND client_code<>'') AS has_code, count(*) AS total FROM report_daily_wholesale\""
```
（report_daily_wholesale 无 client_code——改查 parquet：经 /compute 一次性验证更直接；此处先按 client_code 建，Task 5 /compute 后看行数，稀疏则改 client_name。）

- [ ] **Step 1: 写迁移 108（3 个 report_definitions）**

```sql
-- 108_report_item_customer_compute_defs.sql
-- 3 个 /compute 定义：item_sales / item_outbound / wholesale_customer
-- 幂等：ON CONFLICT DO UPDATE
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES

-- item_sales：retail_detail 按 (品牌,日,商品) 聚合销售金额/利润
('item_sales','销售商品级汇总','report_daily_item_sales','s3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
$SQL$
SELECT regexp_extract(filename,'retail_detail/([0-9]+)/',1) AS system_book_code,
  order_detail_bizday AS biz_date_raw, item_num,
  CAST(SUM(CAST(sale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_amount,
  CAST(SUM(CAST(profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE order_detail_bizday BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"item_num":{"pg_column":"item_num","type":"TEXT"},"sale_amount":{"pg_column":"sale_amount","type":"DECIMAL(14,2)"},"sale_profit":{"pg_column":"sale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'order_detail_bizday','YYYYMMDD','["biz_date","system_book_code","item_num"]'::jsonb),

-- item_outbound：transfer+wholesale 双源 CTE，FULL JOIN 合并（delivery/wholesale 各列）
('item_outbound','出库商品级汇总','report_daily_item_outbound','s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet',
$SQL$
WITH delivery AS (
  SELECT regexp_extract(filename,'transfer_detail/([0-9]+)/',1) AS system_book_code,
    substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) AS biz_date_raw, item_num,
    CAST(SUM(CAST(out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_amount,
    CAST(SUM(CAST(profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet', filename=true)
  WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
),
wholesale AS (
  SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
    substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw, item_num,
    CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet', filename=true)
  WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
)
SELECT COALESCE(d.system_book_code,w.system_book_code) AS system_book_code,
  COALESCE(d.biz_date_raw,w.biz_date_raw) AS biz_date_raw, COALESCE(d.item_num,w.item_num) AS item_num,
  COALESCE(d.delivery_amount,0) AS delivery_amount, COALESCE(d.delivery_profit,0) AS delivery_profit,
  COALESCE(w.wholesale_amount,0) AS wholesale_amount, COALESCE(w.wholesale_profit,0) AS wholesale_profit
FROM delivery d FULL OUTER JOIN wholesale w
  ON d.system_book_code=w.system_book_code AND d.biz_date_raw=w.biz_date_raw AND d.item_num=w.item_num
ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"item_num":{"pg_column":"item_num","type":"TEXT"},"delivery_amount":{"pg_column":"delivery_amount","type":"DECIMAL(14,2)"},"delivery_profit":{"pg_column":"delivery_profit","type":"DECIMAL(14,2)"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'order_time','YYYYMMDD','["biz_date","system_book_code","item_num"]'::jsonb),

-- wholesale_customer：wholesale_detail 按 (品牌,日,客户) 聚合
('wholesale_customer','批发客户级汇总','report_daily_wholesale_customer','s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet',
$SQL$
SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
  substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
  COALESCE(NULLIF(client_code,''), '(无码)'||MAX(client_name)) AS client_code,
  MAX(client_name) AS client_name, MAX(branch_num) AS branch_num,
  CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
  CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"client_code":{"pg_column":"client_code","type":"TEXT"},"client_name":{"pg_column":"client_name","type":"TEXT"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'audit_time','YYYYMMDD','["biz_date","system_book_code","client_code"]'::jsonb)

ON CONFLICT (report_type) DO UPDATE SET
  name=EXCLUDED.name, target_table=EXCLUDED.target_table, source_pattern=EXCLUDED.source_pattern,
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping,
  date_column=EXCLUDED.date_column, date_format=EXCLUDED.date_format, conflict_keys=EXCLUDED.conflict_keys, enabled=true;
DO $$ BEGIN RAISE NOTICE 'Migration 108: item_sales/item_outbound/wholesale_customer compute 定义'; END $$;
```

> 注：`wholesale_customer` template 用 `COALESCE(NULLIF(client_code,''),'(无码)'||MAX(client_name))` 兜底 client_code 稀疏（保证 PK 非空）；若 prod 实测 client_code 普遍有值，可简化。

- [ ] **Step 2: 本地 apply + restart postgrest**
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/108_report_item_customer_compute_defs.sql
docker restart deploy-postgrest-1; sleep 5
```
- [ ] **Step 3: 验证 3 条定义就位**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT report_type, target_table, enabled FROM report_definitions WHERE report_type IN ('item_sales','item_outbound','wholesale_customer') ORDER BY 1;"
```
Expected: 3 行 enabled=t。
- [ ] **Step 4: Commit**
```bash
git add database/migrations/108_report_item_customer_compute_defs.sql
git commit -m "feat(db): item_sales/item_outbound/wholesale_customer 三个 /compute 定义(含双源CTE模板)"
```

---

### Task 3: scheduler triggerCompute 加 3 项

**Files:** Modify `web/lib/scheduler.ts:152-158`（triggerCompute reports 数组）
**Interfaces:** Consumes Task 2 的 report_type；产 C1 采集后自动 /compute（同现有 5 表节奏）。

- [ ] **Step 1: reports 数组追加 3 项**

`web/lib/scheduler.ts` 的 `triggerCompute()` 内 reports 数组追加：
```ts
    { type: "item_sales",          dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "item_outbound",       dateFrom: dates[0],                   dateTo: dates[1] },
    { type: "wholesale_customer",  dateFrom: dates[0],                   dateTo: dates[1] },
```
（插在 daily_wholesale 之后；日期范围同 daily_sales，当天窗口。）

- [ ] **Step 2: tsc + lint**
```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -3
```
- [ ] **Step 3: Commit**
```bash
git add web/lib/scheduler.ts
git commit -m "feat(scheduler): C1 triggerCompute 加 item_sales/item_outbound/wholesale_customer(采集后自动算)"
```

---

### Task 4: architecture.md 同步

**Files:** Modify `docs/architecture.md` §报表体系

- [ ] **Step 1: 加 item/customer 聚合层说明**（在 report_daily_* 表清单后追加 3 表 + 数据流：采集→parquet→C1→/compute→PG→视图，品牌 RLS + 成本脱敏；指向 spec `2026-07-29-report-phase2-data-layer-design.md`）。
- [ ] **Step 2: Commit** `git commit -m "docs: architecture 报表体系加 item/customer 聚合层"`

---

### Task 5: 部署 + /compute 验证（prod）

**注意**：duckdb:9000 仅内网；/compute 经 web 容器调（照 triggerCompute）。local dev 无 S3 parquet → 验证在 prod。

- [ ] **Step 1: 合并 + push 部署**
```bash
git checkout main && git merge --no-ff <branch> && git push origin main
gh run watch <run>   # 等 5 steps 全绿
```
- [ ] **Step 2: prod restart postgrest（GHA 不保证）+ 逐个触发 /compute（近 7 天）**
```bash
ssh ... "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
# 经 web 容器触发（x-agent-key 从 .env）
ssh ... 'docker exec deploy-web-1 sh -lc "k=\$(grep ^AGENT_API_KEY /opt/data-analytics-platform/deploy/.env|cut -d= -f2); for t in item_sales item_outbound wholesale_customer; do echo \"=== \$t ===\"; node -e \"fetch(\\\"http://duckdb:9000/compute\\\",{method:POST,headers:{\\\"x-agent-key\\\":process.env.AGENT_API_KEY,\\\"Content-Type\\\":\\\"application/json\\\"},body:JSON.stringify({report_type:\\\"\$t\\\",date_from:\\\"2026-07-22\\\",date_to:\\\"2026-07-29\\\"})}).then(r=>r.json()).then(d=>console.log(d.success,d.rows_written,d.error||\\\"\\\"))\"; done"'
```
Expected: 三个 success=true，rows_written>0。
- [ ] **Step 3: 验证落表 + 品牌分布 + 完整性（行数 vs 库已有 daily 对账）**
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT 'item_sales' t, system_book_code, count(*) FROM report_daily_item_sales WHERE biz_date>='2026-07-22' GROUP BY 2
UNION ALL SELECT 'item_outbound', system_book_code, count(*) FROM report_daily_item_outbound WHERE biz_date>='2026-07-22' GROUP BY 2
UNION ALL SELECT 'wholesale_customer', system_book_code, count(*) FROM report_daily_wholesale_customer WHERE biz_date>='2026-07-22' GROUP BY 2 ORDER BY 1,2;\""
# compute_logs 全 success
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT report_type, status, count(*) FROM compute_logs WHERE report_type IN ('item_sales','item_outbound','wholesale_customer') GROUP BY 1,2;\""
```
Expected: 两品牌均有行；compute_logs 全 success。
- [ ] **Step 4: 品牌表品品甜配送来源可算性 spot-check**（wholesale_customer 里 client→品品甜门店映射后金额）
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) AS ppp_clients_match_store FROM report_daily_wholesale_customer w JOIN dim_branch b ON b.system_book_code='64188' AND b.branch_name=w.client_name WHERE w.system_book_code='3120' AND w.biz_date>='2026-07-22';\""
```
Expected: >0（品品甜门店作为熊喵批发客户有数据）。
- [ ] **Step 5: 若 client_code 稀疏致 wholesale_customer 行数异常 → 回 Task 2 改 grain 为 client_name，重部署**。

---

## 部署后
- C1 自动链已含 3 新表，后续采集自动算，无需手动。
- 解锁 step 1（品牌×指标表，含品品甜配送=wholesale_customer）+ step 2（商品 TOP20/出库下钻/批发客户报表）—— 另开 spec。
