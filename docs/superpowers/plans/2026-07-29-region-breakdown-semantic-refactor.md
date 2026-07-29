# region_breakdown 语义层重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. `- [ ]` checkboxes.

**Goal:** 修「门店零售/配送数据报表」卡片下钻数据不准 + 公式入语义层：用真实三级目标（不再平摊）、delivery 含品品甜批发、公式在 metric_registry 先定义。

**Architecture:** 两步——(1) metric_registry 加派生指标定义（真相源）；(2) 重建 `report_region_breakdown_v` 视图照定义实现（store 级目标用真实 store target、region/war_zone 用真实分解目标、delivery = 调拨+品品甜批发）。卡片 UI 不变。

**Tech Stack:** PostgreSQL view、metric_registry、PostgREST。

## Global Constraints
- 门店键 = (system_book_code, branch_num) 复合，禁单列 branch_num。
- 视图幂等：DROP VIEW IF EXISTS + CREATE VIEW（不用 CREATE OR REPLACE）；security_invoker；部署后 restart postgrest。
- delivery 口径 = report_daily_delivery(3120 门店) + report_daily_wholesale_customer(64188 门店，client_name→dim_branch 64188 by branch_name 复合键，assessed)，与品牌表/KPI 一致。
- 三级 = war_zone(first_level_region) / region_l2(second_level_region) / store；各级目标取 target_metric_values 真实分解值（breakdown_level='war_zone'/'region_l2'/'store'）。
- 语义层 metric_registry 是文档型真相源（无运行时引擎），视图照实现。
- 测试：DB 视图 = 本地 apply + SQL 验证 + restart postgrest。

**Spec:** `docs/superpowers/specs/2026-07-29-region-breakdown-semantic-refactor.md`

---

## File Structure
- `database/migrations/119_metric_registry_region_report.sql` — 8 个派生指标定义
- `database/migrations/120_region_breakdown_real_targets.sql` — 重建视图
- `docs/architecture.md` — §报表体系 region_breakdown 口径增补（可选）

---

### Task 1: metric_registry 派生指标定义

**Files:** Create `database/migrations/119_metric_registry_region_report.sql`
**Interfaces:** Produces metric_registry rows（真相源；视图 Task2 照实现）。

- [ ] **Step 1: 写迁移 119**

```sql
-- 119_metric_registry_region_report.sql
-- 门店零售/配送报表的派生指标定义（语义层真相源；report_region_breakdown_v 照实现）。
-- target 来自 target_metric_values（按分解级），actual 来自 report_daily_sales / 配送(调拨+品品甜批发)。
-- 幂等：ON CONFLICT DO UPDATE。
INSERT INTO metric_registry (metric_code, name, description, measure_type, fact_table, value_column, agg, formula, depends_on, additive, unit, data_ready, enabled) VALUES
('sale_target', '销售目标', 'target_metric_values(target_value) metric_code=sale 按分解级(store/region_l2/war_zone)', 'base', 'target_metric_values', 'target_value', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('delivery_target', '配送目标', 'target_metric_values(target_value) metric_code=delivery 按分解级', 'base', 'target_metric_values', 'target_value', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('sale_rate', '销售完成率', 'sale_amount / sale_target', 'derived', NULL, NULL, NULL, 'sale_amount / sale_target', '["sale_amount","sale_target"]'::jsonb, false, '率', true, true),
('delivery_rate', '配送完成率', 'delivery_amount(配送口径) / delivery_target', 'derived', NULL, NULL, NULL, 'delivery_amount / delivery_target', '["delivery_amount","delivery_target"]'::jsonb, false, '率', true, true),
('daily_sale', '当日销售', 'sale_amount 当天(biz_date=LEAST(current_date,end_date))', 'derived', NULL, NULL, NULL, 'sale_amount FILTER(biz_date=latest_day)', '["sale_amount"]'::jsonb, true, '元', true, true),
('daily_delivery', '当日配送', 'delivery_amount 当天', 'derived', NULL, NULL, NULL, 'delivery_amount FILTER(biz_date=latest_day)', '["delivery_amount"]'::jsonb, true, '元', true, true),
('remaining_daily_sale', '剩余日均销售目标', '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)', 'derived', NULL, NULL, NULL, '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)', '["sale_target","sale_amount"]'::jsonb, true, '元', true, true),
('remaining_daily_delivery', '剩余日均配送目标', '(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)', 'derived', NULL, NULL, NULL, '(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)', '["delivery_target","delivery_amount"]'::jsonb, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, measure_type=EXCLUDED.measure_type,
  fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column, agg=EXCLUDED.agg,
  formula=EXCLUDED.formula, depends_on=EXCLUDED.depends_on, unit=EXCLUDED.unit;
DO $$ BEGIN RAISE NOTICE 'Migration 119: metric_registry 加 region 报表 8 派生指标'; END $$;
```

- [ ] **Step 2: 本地 apply**
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/119_metric_registry_region_report.sql
```
- [ ] **Step 3: 验证**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, measure_type, left(formula,50) FROM metric_registry WHERE metric_code IN ('sale_target','sale_rate','daily_sale','remaining_daily_sale','delivery_rate') ORDER BY 1;"
```
Expected: 5+ 行（含新指标，formula/depends_on 正确）。
- [ ] **Step 4: Commit** `git commit -m "feat(db): metric_registry 加 region 报表派生指标(真相源)"`

---

### Task 2: 重建 report_region_breakdown_v（真实三级目标 + delivery 含品品甜）

**Files:** Create `database/migrations/120_region_breakdown_real_targets.sql`
**Interfaces:** Produces `report_region_breakdown_v`（列同原 RegionBreakdownRow，数据准）。

- [ ] **Step 1: 写迁移 120（完整视图 SQL）**

```sql
-- 120_region_breakdown_real_targets.sql
-- 重建 report_region_breakdown_v：三级目标用 target_metric_values 真实分解值（不再平摊/整桶）；
--   delivery = 调拨(3120门店) + 品品甜批发(64188门店收货方)，与品牌表/KPI 一致；
--   公式照 metric_registry（迁移119）实现。
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；security_invoker；部署后 restart postgrest。
DROP VIEW IF EXISTS report_region_breakdown_v;
CREATE VIEW report_region_breakdown_v AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
         (end_date - start_date + 1) AS total_days,
         GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
         LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
),
-- store 级真实目标（sale/delivery）
store_tgt AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code, t.branch_num,
         db.first_level_region AS war_zone, db.second_level_region AS region_l2,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  JOIN dim_branch db ON db.system_book_code=t.system_book_code AND db.branch_num=t.branch_num
  WHERE t.breakdown_level='store' AND t.branch_num<>'ALL' AND is_assessed_war_zone(db.first_level_region)
  GROUP BY t.parent_target_id, t.system_book_code, t.branch_num, db.first_level_region, db.second_level_region
),
-- region_l2 / war_zone 级真实目标
region_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone, t.region_l2,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  WHERE t.breakdown_level='region_l2' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone, t.region_l2
),
wz_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  WHERE t.breakdown_level='war_zone' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone
),
-- 销售实际 by store（窗口、考核）
sale_act AS (
  SELECT tgt.target_id, r.system_book_code, r.branch_num,
         SUM(r.total_sale) AS sale_actual,
         SUM(CASE WHEN r.biz_date=tgt.latest_day THEN r.total_sale ELSE 0 END) AS daily_sale
  FROM tgt JOIN report_daily_sales r ON r.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code=r.system_book_code AND db.branch_num=r.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, r.system_book_code, r.branch_num
),
-- 配送实际 by store：3120 调拨 + 64188 批发(收货方)
dlv_3120 AS (
  SELECT tgt.target_id, d.system_book_code, d.branch_num,
         SUM(d.out_money) AS delivery_actual,
         SUM(CASE WHEN d.biz_date=tgt.latest_day THEN d.out_money ELSE 0 END) AS daily_delivery
  FROM tgt JOIN report_daily_delivery d ON d.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code=d.system_book_code AND db.branch_num=d.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, d.system_book_code, d.branch_num
),
dlv_64188 AS (
  SELECT tgt.target_id, '64188' AS system_book_code, db.branch_num,
         SUM(w.wholesale_amount) AS delivery_actual,
         SUM(CASE WHEN w.biz_date=tgt.latest_day THEN w.wholesale_amount ELSE 0 END) AS daily_delivery
  FROM tgt JOIN report_daily_wholesale_customer w ON w.system_book_code='64188' AND w.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code='64188' AND db.branch_name=w.client_name AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, db.branch_num
),
delivery_act AS (
  SELECT target_id, system_book_code, branch_num, SUM(delivery_actual) AS delivery_actual, SUM(daily_delivery) AS daily_delivery
  FROM (SELECT * FROM dlv_3120 UNION ALL SELECT * FROM dlv_64188) u
  GROUP BY target_id, system_book_code, branch_num
),
-- store 行：所有考核门店（dim_branch 为基，LEFT JOIN 目标+实际，无目标也显示）
store_rows AS (
  SELECT tgt.target_id, 'store' AS level, db.second_level_region AS parent_code,
         db.first_level_region AS region_code, db.first_level_region AS region_name,
         db.second_level_region AS sub_region_code, db.second_level_region AS sub_region_name,
         db.branch_num, db.branch_name,
         COALESCE(st.sale_target,0) AS sale_target,
         COALESCE(sa.sale_actual,0) AS sale_actual,
         COALESCE(st.delivery_target,0) AS delivery_target,
         COALESCE(da.delivery_actual,0) AS delivery_actual,
         COALESCE(sa.daily_sale,0) AS daily_sale,
         COALESCE(da.daily_delivery,0) AS daily_delivery,
         tgt.total_days, tgt.days_elapsed,
         db.first_level_region AS war_zone, db.second_level_region AS region_l2
  FROM tgt CROSS JOIN dim_branch db
  LEFT JOIN store_tgt st ON st.target_id=tgt.target_id AND st.system_book_code=db.system_book_code AND st.branch_num=db.branch_num
  LEFT JOIN sale_act sa ON sa.target_id=tgt.target_id AND sa.system_book_code=db.system_book_code AND sa.branch_num=db.branch_num
  LEFT JOIN delivery_act da ON da.target_id=tgt.target_id AND da.system_book_code=db.system_book_code AND da.branch_num=db.branch_num
  WHERE db.is_active AND db.branch_num<>'99' AND is_assessed_war_zone(db.first_level_region)
),
-- region_l2 行：真实 region 级目标 + SUM(store 实际)
region_rows AS (
  SELECT tgt.target_id, 'sub_region' AS level, rt.war_zone AS parent_code,
         rt.war_zone AS region_code, rt.war_zone AS region_name,
         rt.region_l2 AS sub_region_code, rt.region_l2 AS sub_region_name,
         NULL::text AS branch_num, NULL::text AS branch_name,
         COALESCE(rt.sale_target,0) AS sale_target,
         COALESCE(SUM(sr.sale_actual),0) AS sale_actual,
         COALESCE(rt.delivery_target,0) AS delivery_target,
         COALESCE(SUM(sr.delivery_actual),0) AS delivery_actual,
         COALESCE(SUM(sr.daily_sale),0) AS daily_sale,
         COALESCE(SUM(sr.daily_delivery),0) AS daily_delivery,
         MAX(sr.total_days) AS total_days, MAX(sr.days_elapsed) AS days_elapsed
  FROM tgt JOIN region_tgt rt ON rt.target_id=tgt.target_id
  LEFT JOIN store_rows sr ON sr.target_id=tgt.target_id AND sr.region_l2=rt.region_l2 AND sr.war_zone=rt.war_zone
  GROUP BY tgt.target_id, rt.war_zone, rt.region_l2, rt.sale_target, rt.delivery_target
),
-- war_zone 行：真实 war_zone 级目标 + SUM(store 实际)
wz_rows AS (
  SELECT tgt.target_id, 'region' AS level, NULL::text AS parent_code,
         wt.war_zone AS region_code, wt.war_zone AS region_name,
         NULL::text AS sub_region_code, NULL::text AS sub_region_name,
         NULL::text AS branch_num, NULL::text AS branch_name,
         COALESCE(wt.sale_target,0) AS sale_target,
         COALESCE(SUM(sr.sale_actual),0) AS sale_actual,
         COALESCE(wt.delivery_target,0) AS delivery_target,
         COALESCE(SUM(sr.delivery_actual),0) AS delivery_actual,
         COALESCE(SUM(sr.daily_sale),0) AS daily_sale,
         COALESCE(SUM(sr.daily_delivery),0) AS daily_delivery,
         MAX(sr.total_days) AS total_days, MAX(sr.days_elapsed) AS days_elapsed
  FROM tgt JOIN wz_tgt wt ON wt.target_id=tgt.target_id
  LEFT JOIN store_rows sr ON sr.target_id=tgt.target_id AND sr.war_zone=wt.war_zone
  GROUP BY tgt.target_id, wt.war_zone, wt.sale_target, wt.delivery_target
),
all_rows AS (
  SELECT * FROM store_rows
  UNION ALL SELECT target_id, level, parent_code, region_code, region_name, sub_region_code, sub_region_name,
                   branch_num, branch_name, sale_target, sale_actual, delivery_target, delivery_actual,
                   daily_sale, daily_delivery, total_days, days_elapsed, war_zone, region_l2
  FROM region_rows
  UNION ALL SELECT target_id, level, parent_code, region_code, region_name, sub_region_code, sub_region_name,
                   branch_num, branch_name, sale_target, sale_actual, delivery_target, delivery_actual,
                   daily_sale, daily_delivery, total_days, days_elapsed, region_code, NULL
  FROM wz_rows
)
SELECT target_id, level, parent_code, region_code, region_name, sub_region_code, sub_region_name,
       branch_num, branch_name,
       sale_target, sale_actual,
       CASE WHEN sale_target>0 THEN round(sale_actual/nullif(sale_target,0),4) END AS sale_rate,
       delivery_target, delivery_actual,
       CASE WHEN delivery_target>0 THEN round(delivery_actual/nullif(delivery_target,0),4) END AS delivery_rate,
       daily_sale, daily_delivery,
       CASE WHEN total_days>days_elapsed AND sale_target>0 THEN round((sale_target-sale_actual)/(total_days-days_elapsed),2) END AS remaining_daily_sale_target,
       CASE WHEN total_days>days_elapsed AND delivery_target>0 THEN round((delivery_target-delivery_actual)/(total_days-days_elapsed),2) END AS remaining_daily_delivery_target
FROM all_rows;
ALTER VIEW report_region_breakdown_v OWNER TO postgres;
ALTER VIEW report_region_breakdown_v SET (security_invoker=true);
GRANT SELECT ON report_region_breakdown_v TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 120: region_breakdown_v 真实三级目标 + delivery 含品品甜'; END $$;
```

> 注意 UNION ALL 列对齐：store_rows/region_rows/wz_rows 的 SELECT 列表必须列数+类型一致（store_rows 多了 war_zone/region_l2 用于聚合，UNION 时统一带上）。实现时若报列不齐，按 store_rows 的列顺序对齐 region/wz 的 SELECT。

- [ ] **Step 2: 本地 apply + restart postgrest**
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/120_region_breakdown_real_targets.sql
docker restart deploy-postgrest-1; sleep 5
```
- [ ] **Step 3: 验证（列存在 + 三级目标和自洽 + 品品甜配送>0）**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT level, count(*) n, round(sum(sale_target)) sale_tgt, round(sum(delivery_target)) dlv_tgt FROM report_region_breakdown_v WHERE target_id=22 GROUP BY 1 ORDER BY 1;"
```
Expected: 三级 (region/sub_region/store) 都有行；store 级 sale_target 各店不同（不再全相同）；品品甜门店（system_book_code via branch）delivery_actual>0。
- [ ] **Step 4: 抽查 1 家门店目标 = 目标管理页该店目标**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT branch_num, branch_name, sale_target, round(sale_actual) FROM report_region_breakdown_v WHERE target_id=22 AND level='store' AND sale_target>0 ORDER BY sale_rate DESC NULLS LAST LIMIT 5;"
```
与目标管理页该门店目标比对。
- [ ] **Step 5: Commit** `git commit -m "feat(db): region_breakdown_v 真实三级目标+delivery含品品甜(修下钻不准)"`

---

### Task 3: 部署 + 前端验证

- [ ] **Step 1: push → GHA 部署**
```bash
git push origin main
gh run watch <run-id>
```
- [ ] **Step 2: prod restart postgrest**（GHA 不保证）
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker restart deploy-postgrest-1"
```
- [ ] **Step 3: 前端验证**（企微/浏览器）— 报表中心 → 7月目标 → 门店零售/配送报表：三级展开，各店目标不同、品品甜门店配送>0、完成率合理。

---

## Self-Review
- spec 覆盖：目标真实分解(Task2 store_tgt/region_tgt/wz_tgt) ✓；delivery 含品品甜(Task2 dlv_64188) ✓；公式入 metric_registry(Task1) ✓。
- 列对齐风险：UNION ALL 三段列须一致（Step1 注释提醒）。
- 验证：目标和自洽 + 品牌表 sale_target 一致 + 抽查门店目标。
