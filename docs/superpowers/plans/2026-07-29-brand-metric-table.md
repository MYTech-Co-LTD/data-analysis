# 品牌×指标表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. `- [ ]` checkboxes.

**Goal:** KPI 卡下方加品牌×指标表（熊喵/品品甜/合计 × 销售目标/金额/完成率/配送金额/毛利/毛利率），数据层已就绪。

**Architecture:** 视图 `report_brand_metric_v`（按 active total 目标窗口，两品牌行+合计行，配送品牌异源 3120=daily_delivery/64188=wholesale_customer，profit can_see_cost 脱敏）→ lib → 组件 → desktop/mobile 接入。

**Tech Stack:** PostgreSQL view、PostgREST、Next.js App Router + TS。

## Global Constraints
- 品牌=system_book_code（3120熊喵/64188品品甜，dim_brand）；branch_num 非唯一禁单列用。
- 视图幂等：`DROP VIEW IF EXISTS + CREATE VIEW`（不用 CREATE OR REPLACE，migrate 重跑加列会报 cannot drop）；`security_invoker=true`；加视图后 restart postgrest。
- 成本脱敏：`CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false) THEN profit ELSE NULL END`（照 032_report_security_views）。
- 完成率=时间进度调整：`actual/(target × days_elapsed/total_days)`（照 report_achievement_v progress_rate）。
- margin 原值重算（不 SUM）。
- DESIGN.md：tabular-nums、三色（≥1绿/≥0.8琥珀/<0.8红）、禁 emoji、合计行加粗浅灰。
- 部署：database/+web/ → GHA。
- 测试：DB 视图=本地 apply + SQL 验证 + restart postgrest；前端=tsc/lint + dev-login。

**Spec:** `docs/superpowers/specs/2026-07-29-brand-metric-table-design.md`

---

## File Structure
- `database/migrations/112_report_brand_metric_v.sql` — 视图
- `web/lib/report-center/brand-metric.ts` — getBrandMetric + BrandMetricRow
- `web/components/report-center/brand-metric-table.tsx` — 组件
- `web/app/reports/targets/[id]/{page,desktop,mobile}.tsx` — 接入
- `docs/architecture.md` — §报表体系 增补品牌×指标表

---

### Task 1: 视图 report_brand_metric_v

**Files:** Create `database/migrations/112_report_brand_metric_v.sql`
**Interfaces:** Produces `report_brand_metric_v`（target_id, system_book_code, brand_name, sale_target, sale_amount, sale_rate, delivery_amount, delivery_profit, delivery_margin），3 行/目标（2 品牌+合计）。

- [ ] **Step 1: 写迁移 112**

```sql
-- 112_report_brand_metric_v.sql
-- 品牌×指标表视图：按 active total 目标窗口，每品牌一行 + 合计行。
-- 销售: targets store目标 + report_daily_sales；配送品牌异源(3120=daily_delivery, 64188=wholesale_customer 收货方)；
--   profit 按 can_see_cost 脱敏；完成率时间进度调整；margin 原值重算。
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；security_invoker；部署后 restart postgrest。
DROP VIEW IF EXISTS report_brand_metric_v;
CREATE VIEW report_brand_metric_v AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date,end_date)-start_date+1,0) AS days_elapsed
  FROM targets WHERE target_level='total' AND status='active'
),
sale_target AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code, SUM(tmv.target_value) AS sale_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id
  WHERE t.breakdown_level='store' AND tmv.metric_code='sale'
  GROUP BY t.parent_target_id, t.system_book_code
),
sale_actual AS (
  SELECT tgt.target_id, r.system_book_code, SUM(r.total_sale) AS sale_amount
  FROM tgt JOIN report_daily_sales r
    ON r.system_book_code IN ('3120','64188') AND r.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, r.system_book_code
),
delivery AS (
  SELECT tgt.target_id, '3120'::text AS system_book_code,
    SUM(d.out_money) AS delivery_amount, SUM(d.profit_money) AS delivery_profit
  FROM tgt JOIN report_daily_delivery d ON d.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id
  UNION ALL
  SELECT tgt.target_id, w.system_book_code,
    SUM(w.wholesale_amount), SUM(w.wholesale_profit)
  FROM tgt JOIN report_daily_wholesale_customer w
    ON w.system_book_code='64188' AND w.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, w.system_book_code
),
brand_rows AS (
  SELECT tgt.target_id, b.system_book_code, b.brand_name,
    COALESCE(st.sale_target,0) AS sale_target,
    COALESCE(sa.sale_amount,0) AS sale_amount,
    CASE WHEN COALESCE(st.sale_target,0)>0 AND tgt.days_elapsed>0
      THEN ROUND(COALESCE(sa.sale_amount,0)/(st.sale_target*tgt.days_elapsed/tgt.total_days),4) END AS sale_rate,
    COALESCE(d.delivery_amount,0) AS delivery_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false)
      THEN COALESCE(d.delivery_profit,0) END AS delivery_profit,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false) AND COALESCE(d.delivery_amount,0)>0
      THEN ROUND(COALESCE(d.delivery_profit,0)/NULLIF(d.delivery_amount,0),4) END AS delivery_margin
  FROM tgt CROSS JOIN dim_brand b
  LEFT JOIN sale_target st ON st.target_id=tgt.target_id AND st.system_book_code=b.system_book_code
  LEFT JOIN sale_actual sa ON sa.target_id=tgt.target_id AND sa.system_book_code=b.system_book_code
  LEFT JOIN delivery d ON d.target_id=tgt.target_id AND d.system_book_code=b.system_book_code
)
SELECT * FROM brand_rows
UNION ALL
SELECT br.target_id, '合计' AS system_book_code, NULL AS brand_name,
  SUM(br.sale_target) AS sale_target,
  SUM(br.sale_amount) AS sale_amount,
  CASE WHEN SUM(br.sale_target)>0 AND tgt.days_elapsed>0
    THEN ROUND(SUM(br.sale_amount)/(SUM(br.sale_target)*tgt.days_elapsed/tgt.total_days),4) END AS sale_rate,
  SUM(br.delivery_amount) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false)
    THEN SUM(br.delivery_profit) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false) AND SUM(br.delivery_amount)>0
    THEN ROUND(SUM(br.delivery_profit)/NULLIF(SUM(br.delivery_amount),0),4) END AS delivery_margin
FROM brand_rows br JOIN tgt ON tgt.target_id=br.target_id
GROUP BY br.target_id, tgt.days_elapsed, tgt.total_days;
ALTER VIEW report_brand_metric_v OWNER TO postgres;
ALTER VIEW report_brand_metric_v SET (security_invoker=true);
GRANT SELECT ON report_brand_metric_v TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 112: report_brand_metric_v（品牌×指标表，3行/目标）'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/112_report_brand_metric_v.sql
docker restart deploy-postgrest-1; sleep 5
```
- [ ] **Step 3: 验证（本地 dev 无 active 目标→空；用 prod 读验证）**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT * FROM report_brand_metric_v;"  # 本地空（无 active total 目标），结构在即可
# 结构 + 列类型
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d+ report_brand_metric_v"
```
Expected: 视图建成，9 列（target_id/.../delivery_margin）；本地行 0（dev 无 active total 目标数据），prod 部署后会有 3 行。
- [ ] **Step 4: Commit** `git commit -m "feat(db): report_brand_metric_v 视图(品牌×指标+合计,配送品牌异源,成本脱敏)"`

---

### Task 2: lib getBrandMetric

**Files:** Create `web/lib/report-center/brand-metric.ts`
**Interfaces:** Produces `getBrandMetric(targetId)` → `BrandMetricRow[]`（Task 3 组件用）。

- [ ] **Step 1: 写 lib**
```ts
// web/lib/report-center/brand-metric.ts
// 品牌×指标表数据获取（report_brand_metric_v，3 行：熊喵/品品甜/合计）
import { getClient } from "@/lib/api";

export interface BrandMetricRow {
  target_id: number;
  system_book_code: string;        // '3120' / '64188' / '合计'
  brand_name: string | null;
  sale_target: number;
  sale_amount: number;
  sale_rate: number | null;        // 时间进度调整完成率
  delivery_amount: number;
  delivery_profit: number | null;  // can_see_cost=false→NULL
  delivery_margin: number | null;
}

export async function getBrandMetric(targetId: number): Promise<BrandMetricRow[]> {
  const client = await getClient();
  const { data, error } = await client.database
    .from("report_brand_metric_v")
    .select("*")
    .eq("target_id", targetId)
    .order("system_book_code", { ascending: true }); // 3120, 64188, 合计
  if (error) { console.error("brand_metric fetch:", error); return []; }
  return (data ?? []) as BrandMetricRow[];
}
```
- [ ] **Step 2: tsc** `cd web && npx tsc --noEmit`
- [ ] **Step 3: Commit** `git commit -m "feat(report-center): getBrandMetric lib + BrandMetricRow 类型"`

---

### Task 3: BrandMetricTable 组件

**Files:** Create `web/components/report-center/brand-metric-table.tsx`
**Interfaces:** Consumes `BrandMetricRow[]`（Task 2）；产呈现（desktop/mobile 复用，响应式）。

- [ ] **Step 1: 写组件**（"use client"；照 DESIGN.md：tabular-nums、完成率三色 `rateColor`、合计行加粗 bg-slate-50、表头"品牌｜销售目标｜销售金额｜销售完成率｜配送金额｜配送毛利｜配送毛利率"；金额 fmtWan 万化、率 fmtPercent；空态"暂无品牌数据"；移动端横向滚动）
- [ ] **Step 2: tsc + lint**
- [ ] **Step 3: Commit** `git commit -m "feat(report-center): BrandMetricTable 组件(三色完成率+合计行+tabular-nums)"`

> 实现参照 `web/components/report-center/category-summary.tsx`（同类表格组件，复用 fmtWan/fmtPercent/rateColor 模式 + chart-actions 导出按钮可选）。

---

### Task 4: 接入看板

**Files:** Modify `web/app/reports/targets/[id]/{page,desktop,mobile}.tsx`
**Interfaces:** Consumes Task 2 getBrandMetric + Task 3 组件。

- [ ] **Step 1: page.tsx** — `Promise.all` 加 `getBrandMetric(targetId)`；props 传 desktop/mobile。
- [ ] **Step 2: desktop.tsx** — KpiCards 下方、RegionDrillTable 上方加 `<BrandMetricTable rows={brandMetric} />`（加 section 标题 `${targetMonth}月品牌×指标`）。
- [ ] **Step 3: mobile.tsx** — 同位（KPI 下、RegionDrill 上），`<div className="px-4">` 包裹。
- [ ] **Step 4: tsc + lint + build**
- [ ] **Step 5: Commit** `git commit -m "feat(report-center): 看板接入品牌×指标表(KPI下方,PC+移动)"`

---

### Task 5: 部署 + 验证

- [ ] **Step 1: 合并 + push**（GHA 全量）
- [ ] **Step 2: prod restart postgrest**（视图新加，GHA 不保证）
- [ ] **Step 3: 验证视图数据**（prod, target 22）
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT system_book_code, brand_name, round(sale_target), round(sale_amount), sale_rate, round(delivery_amount), round(delivery_profit) FROM report_brand_metric_v WHERE target_id=22 ORDER BY system_book_code;\""
```
Expected: 3 行（3120熊喵/64188品品甜/合计），两品牌 sale_target>0、delivery_amount>0（品品甜配送=wholesale 64188）。
- [ ] **Step 4: 前端 dev-login 手动验证**（或企微客户端）— 看板 KPI 下方出现品牌×指标表，三色完成率、合计行、移动横向滚动。
