# C2 视图断言扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 往 qa-checks.json 加 7 条 ViewAssertion（视图↔聚合对账），让 9 个 report_*_gen 视图从"几乎裸奔"到 sale/delivery/wholesale 金额层有运行期守护。

**Architecture:** 纯配置--qa-checks.json 加条目，生成器 index.ts 按 view 自动产 `${view}_qa.sql`（不改生成器代码）。ref_sql 独立手写（不经 AST），gen-views 部署时即时跑断言 diff>0.01 阻断。

**Tech Stack:** JSON 配置 / TypeScript 生成器（services/semantic-generator）/ vitest / GHA 部署

**Spec:** `docs/superpowers/specs/2026-08-05-c2-view-assertions-design.md`

## Global Constraints
- **ref_sql 独立手写**（不经生成器 AST），与视图口径相互独立--否则共享 bug 断言失去意义。
- **不改生成器代码**（`src/generators/*.ts`）--加断言是改配置数据，符合铁律。
- **配置同步**：`services/semantic-generator/src/qa-checks.json` 改后**字节同步** `web/lib/qa/config/qa-checks.json`（`config-sync.test.ts` 强制）。
- **targets join**：ref_sql 一律 `JOIN targets t ON biz_date BETWEEN start_date AND end_date AND target_level='total' AND status='active'`（与生成视图 tgt 一致，架构 §10.10 定稿）。
- **考核过滤**：sale/delivery/distribution 带 `is_assessed_war_zone`，wholesale 全量不过滤。
- **tolerance**：0.01 元。
- **migrate.sh**：generated 产物按 `LC_ALL=C` 字节序（基视图 `.` < `_qa` 的 `_`）。

## File Structure
| 文件 | 责任 | 动作 |
|---|---|---|
| `services/semantic-generator/src/qa-checks.json` | ViewAssertion 真相源 | 改（加 7 条） |
| `web/lib/qa/config/qa-checks.json` | web 运行时副本 | 改（字节同步） |
| `database/generated/*_qa.sql` | gen-views 产物 | 生成器产（不改手写） |
| `services/semantic-generator/__tests__/qa-view.test.ts` | _qa 视图生成测试 | 不改（已含 brand_metric sale_amount 硬编码断言，新条目结构合法即过） |

---

### Task 1: qa-checks.json 加 7 条断言 + gen-views 验证 + 测试

**Files:**
- Modify: `services/semantic-generator/src/qa-checks.json`
- Modify: `web/lib/qa/config/qa-checks.json`（字节同步）
- Generate: `database/generated/report_{brand_metric_gen,region_breakdown_gen,supply_chain_outbound_gen,wholesale_customer_gen,wholesale_daily_gen}_qa.sql`

**Interfaces:**
- Consumes: 现有 `qa-checks.json` 的 brand_metric sale_amount 条目（保留，在其后追加 7 条）
- Produces: 7 条新 ViewAssertion；5 个 `${view}_qa.sql`（brand_metric_gen_qa 含 3 条：sale_amount + sale_target + delivery_amount）

- [ ] **Step 1: 读现有 qa-checks.json 确认格式**

Read `services/semantic-generator/src/qa-checks.json`（当前 1 条 brand_metric sale_amount）。确认 ViewAssertion schema：`{view, metric, view_sum_filter, ref_sql, tolerance}`。

- [ ] **Step 2: 改 services/qa-checks.json 追加 7 条**

把 `services/semantic-generator/src/qa-checks.json` 改为以下完整数组（现有 sale_amount 保留 + 7 条新追加）：

```json
[
  {
    "view": "report_brand_metric_gen",
    "metric": "sale_amount",
    "view_sum_filter": "system_book_code <> '合计'",
    "ref_sql": "SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))",
    "tolerance": 0.01
  },
  {
    "view": "report_brand_metric_gen",
    "metric": "sale_target",
    "view_sum_filter": "system_book_code <> '合计'",
    "ref_sql": "SELECT COALESCE(SUM(tmv.target_value), 0) FROM target_metric_values tmv JOIN targets bt ON bt.id = tmv.target_id WHERE tmv.metric_code = 'sale' AND bt.breakdown_level = 'store' AND bt.parent_target_id IN (SELECT id FROM targets WHERE target_level = 'total' AND status = 'active')",
    "tolerance": 0.01
  },
  {
    "view": "report_brand_metric_gen",
    "metric": "delivery_amount",
    "view_sum_filter": "system_book_code <> '合计'",
    "ref_sql": "SELECT COALESCE((SELECT SUM(d.out_money) FROM report_daily_delivery d JOIN targets t ON d.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = d.system_book_code AND db.branch_num = d.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) + COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w JOIN targets t ON w.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE w.system_book_code = '64188' AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))), 0)",
    "tolerance": 0.01
  },
  {
    "view": "report_region_breakdown_gen",
    "metric": "sale_actual",
    "view_sum_filter": "level = 'store'",
    "ref_sql": "SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))",
    "tolerance": 0.01
  },
  {
    "view": "report_region_breakdown_gen",
    "metric": "delivery_actual",
    "view_sum_filter": "level = 'store'",
    "ref_sql": "SELECT COALESCE((SELECT SUM(d.out_money) FROM report_daily_delivery d JOIN targets t ON d.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = d.system_book_code AND db.branch_num = d.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) + COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w JOIN targets t ON w.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE w.system_book_code = '64188' AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))), 0)",
    "tolerance": 0.01
  },
  {
    "view": "report_supply_chain_outbound_gen",
    "metric": "delivery_amount",
    "view_sum_filter": "level = 'store'",
    "ref_sql": "SELECT COALESCE((SELECT SUM(d.out_money) FROM report_daily_delivery d JOIN targets t ON d.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = d.system_book_code AND db.branch_num = d.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) + COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w JOIN targets t ON w.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active' WHERE w.system_book_code = '64188' AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))), 0)",
    "tolerance": 0.01
  },
  {
    "view": "report_wholesale_customer_gen",
    "metric": "wholesale_amount",
    "view_sum_filter": "1=1",
    "ref_sql": "SELECT COALESCE(SUM(s.wholesale_amount), 0) FROM report_daily_wholesale_customer s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active'",
    "tolerance": 0.01
  },
  {
    "view": "report_wholesale_daily_gen",
    "metric": "wholesale_ext_amount",
    "view_sum_filter": "1=1",
    "ref_sql": "SELECT COALESCE(SUM(s.wholesale_money), 0) FROM report_daily_wholesale s JOIN targets t ON s.biz_date BETWEEN t.start_date AND LEAST(current_date, t.end_date) AND t.target_level = 'total' AND t.status = 'active' WHERE s.system_book_code = '3120'",
    "tolerance": 0.01
  }
]
```

- [ ] **Step 3: 字节同步 web 副本**

把 `web/lib/qa/config/qa-checks.json` 改为与 services 版**完全一致**（`config-sync.test.ts` 字节断言）。

验证：`diff services/semantic-generator/src/qa-checks.json web/lib/qa/config/qa-checks.json` -> 无差异。

- [ ] **Step 4: 跑 gen-views（产 _qa.sql + 即时断言）**

```bash
cd services/semantic-generator
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insforge npm run gen-views
```
（DATABASE_URL 取 `services/semantic-generator/.env`；若本地 dev DB 无数据，diff 应全 0；若有数据且 diff!=0，见 Step 5）

Expected：`✅ 生成器完成` + `断言失败 0 个`。产物 `database/generated/report_*_qa.sql` 生成（brand_metric_gen_qa 含 3 条 UNION ALL、region_breakdown_gen_qa 含 2 条、supply_chain_outbound_gen_qa 1 条、wholesale_customer_gen_qa 1 条、wholesale_daily_gen_qa 1 条）。

- [ ] **Step 5: 若有 assertionFailures（diff>0.01）修 ref_sql**

若 Step 4 输出 `断言失败 N 个` + 列出 `<view>.<metric>: 视图 X vs 上游 Y (diff Z)`：
- 对照 spec 口径要点排查 ref_sql（考核过滤/品品甜 distribution/level store/date grain）
- 修 `services/qa-checks.json` 对应 ref_sql + 同步 web 副本
- 重跑 Step 4 直到 `断言失败 0 个`

> 注：若本地 dev DB 无8月数据（view_sum=0, ref_sum=0, diff=0），不能真正验证口径--生产部署后 Step 2 验证。本地至少保证 SQL 语法正确（EXPLAIN 通过 + gen-views 不 exit 1）。

- [ ] **Step 6: 跑测试**

```bash
cd services/semantic-generator && npm test
cd web && npx vitest run lib/qa/__tests__/config-sync.test.ts
```
Expected：qa-view + qa-config + ast + tier1 + hierarchy + perm-filter 全绿；config-sync 字节一致通过。

- [ ] **Step 7: 验证 _qa.sql 产物结构（抽样）**

```bash
cat database/generated/report_brand_metric_gen_qa.sql
```
Expected：DROP VIEW + CREATE VIEW + 3 条 UNION ALL（sale_amount/sale_target/delivery_amount），每条 `SELECT 'metric' AS metric, COALESCE((SELECT SUM(...) FROM view WHERE filter),0) AS view_sum, COALESCE((ref_sql),0) AS ref_sum`。

- [ ] **Step 8: Commit**

```bash
git add services/semantic-generator/src/qa-checks.json web/lib/qa/config/qa-checks.json database/generated/*_qa.sql
git commit -m "feat(qa): C2 视图断言扩展 7 条(sale/delivery/wholesale 金额,避开 profit/outbound)"
```

---

### Task 2: GHA 部署 + 生产验证

**Files:** 无（部署 + 验证）

- [ ] **Step 1: push main 触发 GHA**

```bash
git push origin main
```
（改 `web/` + `services/` + `database/generated/`，按 CLAUDE.md 走 GHA 完整部署）

- [ ] **Step 2: 监控 GHA**

```bash
gh run list --limit 1
gh run watch <run-id>
```
Expected：5 steps 全绿（rsync + 后端 + 迁移[含 generated _qa.sql LC_ALL=C 字节序] + functions + 前端构建）。migrate 后 postgrest 自动 restart（deploy.sh）。

- [ ] **Step 3: 部署后生产验证 diff=0**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT view||'.'||metric AS check, view_sum, ref_sum, diff FROM (SELECT 'brand_metric' AS view, metric, view_sum, ref_sum, diff FROM report_brand_metric_gen_qa UNION ALL SELECT 'region', metric, view_sum, ref_sum, diff FROM report_region_breakdown_gen_qa UNION ALL SELECT 'supply', metric, view_sum, ref_sum, diff FROM report_supply_chain_outbound_gen_qa UNION ALL SELECT 'wholesale_customer', metric, view_sum, ref_sum, diff FROM report_wholesale_customer_gen_qa UNION ALL SELECT 'wholesale_daily', metric, view_sum, ref_sum, diff FROM report_wholesale_daily_gen_qa) t ORDER BY view, metric;\""
```
Expected：8 行（含原有 sale_amount），**所有 diff=0.00**。若有 diff!=0，对照 spec 口径修 ref_sql + 重部署（gen-views 即时断言应已本地抓到，生产 diff!=0 多为本地 dev DB 无数据未验证口径）。

- [ ] **Step 4: 跑一次 qa-runner C2（可选，确认 qa_logs 写入）**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/qa-run?check=C2 -H "Cookie: <admin cookie>"
```
或生产 `npx tsx scripts/qa-run.ts --check=C2`。Expected：C2 全 PASS，qa_logs 有记录。

---

## Self-Review

**Spec coverage：** spec 7 条断言（brand_metric sale_target/delivery_amount + region sale_actual/delivery_actual + supply_chain delivery_amount + wholesale_customer wholesale_amount + wholesale_daily wholesale_ext_amount）-> Task 1 Step 2 全覆盖 ✅。避开 profit/outbound -> spec 避开项 ✅。配置同步 -> Step 3 ✅。部署验证 -> Task 2 ✅。

**Placeholder scan：** 无 TBD/TODO。每条 ref_sql 完整 SQL（非"参考 spec"）。Task 1 Step 5 含 diff!=0 修 ref_sql 迭代说明。

**Type consistency：** ViewAssertion schema（view/metric/view_sum_filter/ref_sql/tolerance）与现有 brand_metric sale_amount 一致；ref_sql 都返单值 SUM（COALESCE 0）；tolerance 0.01 统一。

**风险点：** ref_sql 口径精确性靠 gen-views 即时断言 + 生产 diff=0 验证（Task 2 Step 3）。若本地 dev DB 无8月数据，本地 diff 全 0 不能真正验证口径--生产验证是终极关卡。
