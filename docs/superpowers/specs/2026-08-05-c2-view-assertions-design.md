# C2 视图断言扩展设计（视图↔聚合对账）

日期：2026-08-05
状态：brainstorming design 已获批，待 commit；待用户 review 后 writing-plans
上位规划：`docs/superpowers/specs/2026-08-05-data-accuracy-guard-overall-design.md`（子系统③视图层）
基线 spec：`docs/superpowers/specs/2026-08-03-data-accuracy-semantic-layer-design.md`（C2 设计意图）

## Context

基线 spec 的 C2（视图↔聚合表 SUM 一致）目前只落地 1 条断言（`report_brand_metric_gen.sale_amount`），9 个 `report_*_gen` 视图几乎裸奔。C2 是"视图口径正确"的运行期守护--视图丢行/丢品牌/口径漂移能被发现。本 spec 补齐第一版断言（7 条，聚焦 sale/delivery/wholesale 金额），**避开成本敏感 profit + 品类级 outbound**（第一版不做，留后续）。

## 机制（纯配置，不改生成器）

- 往 `services/semantic-generator/src/qa-checks.json` 加 `ViewAssertion{view, metric, view_sum_filter, ref_sql, tolerance}` 条目
- 生成器 `index.ts:65` 按 view 名 filter，自动产 `${view}_qa.sql`（不改生成器代码，符合铁律）
- **ref_sql 独立手写**（不经 AST），与视图口径相互独立--否则共享 bug 断言失去意义
- 部署时 `gen-views` 立即跑断言，`diff>0.01` 阻断（exit 1）--ref_sql 口径写错会被即时抓到
- 配置同步：`services/` 改后字节同步 `web/lib/qa/config/qa-checks.json`（`config-sync.test.ts` 强制）

## 断言清单（7 条）

### 共用片段

考核门店 EXISTS（sale/delivery/distribution 用）：
```sql
EXISTS (SELECT 1 FROM dim_branch db
  WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  AND is_assessed_war_zone(db.first_level_region))
```

品品甜门店映射（wholesale_pp 64188 用，按 client_name 找 branch）：
```sql
EXISTS (SELECT 1 FROM dim_branch db
  WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name
  AND is_assessed_war_zone(db.first_level_region))
```

targets join（一律）：
```sql
JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date
  AND t.target_level = 'total' AND t.status = 'active'
```

### 1. report_brand_metric_gen / sale_target
- `view_sum_filter`: `system_book_code <> '合计'`
- `ref_sql`:
```sql
SELECT COALESCE(SUM(tmv.target_value), 0) FROM target_metric_values tmv
JOIN targets bt ON bt.id = tmv.target_id
WHERE tmv.metric_code = 'sale' AND bt.breakdown_level = 'store'
  AND bt.parent_target_id IN (SELECT id FROM targets WHERE target_level = 'total' AND status = 'active')
```

### 2. report_brand_metric_gen / delivery_amount（distribution 口径）
- `view_sum_filter`: `system_book_code <> '合计'`
- `ref_sql`（delivery 考核 + wholesale_pp 64188 考核）:
```sql
SELECT COALESCE((SELECT SUM(d.out_money) FROM report_daily_delivery d
  JOIN targets t ON d.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active'
  WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = d.system_book_code AND db.branch_num = d.branch_num AND is_assessed_war_zone(db.first_level_region))), 0)
+ COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
  JOIN targets t ON w.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active'
  WHERE w.system_book_code = '64188' AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))), 0)
```

### 3. report_region_breakdown_gen / sale_actual（level='store' 叶级）
- `view_sum_filter`: `level = 'store'`
- `ref_sql`:
```sql
SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s
JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active'
WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))
```

### 4. report_region_breakdown_gen / delivery_actual（level='store'，distribution）
- `view_sum_filter`: `level = 'store'`
- `ref_sql`: 同断言 2（distribution 口径：delivery 考核 + wholesale_pp 64188 考核）

### 5. report_supply_chain_outbound_gen / delivery_amount（level='store'，distribution）
- `view_sum_filter`: `level = 'store'`
- `ref_sql`: 同断言 2（distribution 口径）

### 6. report_wholesale_customer_gen / wholesale_amount（全量，无考核过滤）
- `view_sum_filter`: `1=1`（无合计行）
- `ref_sql`:
```sql
SELECT COALESCE(SUM(s.wholesale_amount), 0) FROM report_daily_wholesale_customer s
JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status = 'active'
```

### 7. report_wholesale_daily_gen / wholesale_ext_amount（sbc=3120，date grain latest_day）
- `view_sum_filter`: `1=1`（无合计行）
- `ref_sql`（date grain，join 上限 LEAST(current_date, end_date)）:
```sql
SELECT COALESCE(SUM(s.wholesale_money), 0) FROM report_daily_wholesale s
JOIN targets t ON s.biz_date BETWEEN t.start_date AND LEAST(current_date, t.end_date) AND t.target_level = 'total' AND t.status = 'active'
WHERE s.system_book_code = '3120'
```

## 口径要点（ref_sql 编写铁律）
1. **考核过滤**：sale/delivery/distribution 带 `is_assessed_war_zone`，wholesale 全量不过滤（对齐视图口径）
2. **品品甜配送**：`delivery_*` 列实为 distribution（含 64188 wholesale_customer），ref_sql 必须两源 + `db.branch_name=w.client_name` 映射（非 branch_num）
3. **层级视图**：region/supply_chain 必须 `level='store'`（叶级，避免 region/sub_region/store 三级 rollup 翻倍）
4. **date grain**：wholesale_daily 的 join 上限用 `LEAST(current_date, t.end_date)`（至当日，非全周期 end_date）
5. **tolerance**：0.01 元

## 配置同步
- `services/semantic-generator/src/qa-checks.json`（真相源）
- `web/lib/qa/config/qa-checks.json`（web 副本，字节同步，`config-sync.test.ts` 强制）

## 部署验证
1. 跑 `gen-views`（产 `${view}_qa.sql` + gen 时立即跑断言，`diff>0.01` exit 1）
2. 跑 `services/semantic-generator && npm test`（qa-view + qa-config + config-sync）
3. 跑 `web && npm test`（config-sync）
4. GHA 部署（migrate.sh 应用 generated `_qa.sql` + restart postgrest）
5. 部署后 `SELECT metric,view_sum,ref_sum,diff FROM <view>_qa` 验证 diff=0

## 避开项（第一版不做，留后续）
- **成本敏感列**（profit/margin）：视图无 `can_see_cost` 时返 NULL，QA 对比假阴--需 service 身份跑或带 `can_see_cost=true` 守护，复杂，留后续
- **品类级 outbound_amt/outbound_profit**：FULL JOIN delivery+wholesale 按 category_group，ref_sql 复杂，留后续
- **achievement_gen actual_value**：独立生成器不产 `_qa`，需改 `index.ts`（架构变更），留后续

## 后续
本 spec 获批后 -> writing-plans 拆实施 task（改 qa-checks.json + web 副本 + gen-views 验证 + 部署）。C2 完成后按总体规划推进 C1（compute 收口）/ D1（重复重采覆盖）。
