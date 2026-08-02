# 报表 Phase 2 前端板块设计（商品 TOP 榜 + 出库下钻 + 批发客户报表）

**日期**：2026-08-02
**状态**：已确认，待实现
**前置**：Phase 2 数据层（迁移 107/108，`report_daily_item_sales`/`item_outbound`/`wholesale_customer` 已建 + C1 自动聚合跑着）、语义层生成器（P0-P2 完成，反自由发挥铁律生效）、目标看板 `/reports/targets/[id]`（KPI/区域/类别/品牌四板块已上线）
**关联**：`docs/superpowers/specs/2026-07-29-report-phase2-data-layer-design.md`（数据层）、`2026-07-21-report-center-redesign-design.md`（报表中心）、`DESIGN.md`（报表中心约定）

---

## 1. 背景与目标

### 1.1 现状缺口

Phase 2 数据层已就绪（3 张 item/customer 聚合表 + C1 自动 /compute），但用这些数据解锁的**前端报表板块未落地**——`grep item_sales/wholesale_customer/TOP20` 在 `web/components`/`web/lib` 零命中（仅 scheduler 用）。需把数据接入报表中心看板。

### 1.2 目标

在现有目标看板 `/reports/targets/[id]` 下方追加 3 个板块，复用目标周期作时间窗口：

1. **商品 TOP 榜**：4 榜（销售月榜/日榜 + 出库月榜/日榜），全品牌合并按 `item_code`
2. **出库商品下钻**：TOP 点入弹层 + 下方完整出库商品列表（可筛分页）
3. **批发客户报表**：3120 客户排行，突出品品甜占比

---

## 2. 数据层：2 个新 gen 视图（服务 3 板块）

口径定义走语义层生成器（反自由发挥铁律：新视图 = 改 view-configs，不在生成器加口径分支）。

### 2.1 `report_item_breakdown_gen`（服务板块 1 + 2）

- `dim_code='item'`，grain = `item_code`（join `dim_item` 合并跨品牌，覆盖率 100% 已验）
- 指标列：`sale_amount`/`sale_profit` + `delivery_amount`/`delivery_profit` + `wholesale_amount`/`wholesale_profit` + `outbound_amount`/`outbound_profit`（derived = delivery + wholesale，`metric_registry.formula_ast` 已有）
- 带 `target_id`（仅借目标周期做时间窗口 `biz_date BETWEEN t.start_date AND t.end_date`，**无 target 列**——item 级无目标分解）
- 附 `item_name`/`category_name`/`top_category`/`item_brand`（`dim_item` join 带出，供榜单展示 + 列表筛选）
- 前端用途：销售月榜 `ORDER BY sale_amount DESC LIMIT 20`；出库月榜 `ORDER BY outbound_amount DESC LIMIT 20`；完整列表分页

### 2.2 `report_wholesale_customer_gen`（服务板块 3）

- `dim_code='customer'`，grain = `client_code`
- 指标列：`wholesale_amount`/`wholesale_profit`
- 带 `target_id`（借周期，无 target 列）
- 附 `client_name` + `system_book_code`（供前端筛 3120）+ `is_pinpintian`（boolean，3120 行 `client_name` EXISTS join `dim_branch db ON db.branch_name = client_name AND db.system_book_code='64188'` 标记品品甜门店）
- 前端用途：3120 客户排行 + 品品甜占比汇总

### 2.3 生成器改动（反自由发挥约束）

- `view-configs.ts` 加 2 个配置（`dim_code:'item'/'customer'`，`has_target: false` 新开关）
- `tier1.ts` 支持 `has_target=false`：跳过 target join CTE，只保留 target_id 借周期（`JOIN targets t ON t.id = ?` 取 `start_date`/`end_date` 做窗口，不产 target 列）——**配置驱动的通用能力，非业务口径分支**（不违反铁律）
- `dim_item`/`dim_branch` 作 `dim_table` cross-join 保证空商品/客户也出现

---

## 3. 组件设计

3 板块挂 `/reports/targets/[id]` 看板下方（PC `desktop.tsx` + 移动 `mobile.tsx` 都加）。

```
/reports/targets/[id]
├─ KpiCards（现有）
├─ RegionDrillTable（现有）
├─ CategorySummary（现有）
├─ BrandMetricTable（现有）
├─ ItemTopBoards           ← 新（4 榜 + 点入弹层）
├─ ItemOutboundList        ← 新（完整出库商品交叉表，可筛分页）
└─ WholesaleCustomerReport ← 新（3120 客户排行 + 品品甜占比）
```

### 3.1 `ItemTopBoards`（板块 1 + 2 的榜部分）

- **4 榜 2 行 2 列**（PC）：上行 销售月榜 | 销售日榜，下行 出库月榜 | 出库日榜
- 月榜 = 周期累计（`biz_date BETWEEN start_date AND end_date`）TOP20
- 日榜 = 选定日 TOP20；日期选择器：
  - 默认日期：`today` 在 `[start_date, end_date]` 内 → `today`；`today > end_date` → `end_date`；`today < start_date` → `start_date`
  - 可选范围：`[start_date, min(end_date, today)]`（截至当天）
- 每行：排名 + `item_name` + 金额（`¥XX.X万`）+ 占比%（占该榜总额）
- 占比三色（借 DESIGN.md 达成三色）：>10% 蓝 / 5-10% 琥珀 / <5% 灰
- 点行 → 弹 `ItemDetailDrawer`
- 月榜 + 日榜默认日：`page.tsx` server 预取（`ORDER BY`+`LIMIT 20`，不传全集）；日榜**切换日期 client fetch**（单日 TOP20 量小）
- ⬇Excel/🖼图片/🔗分享（`chart-actions`，组件级，同现有）

### 3.2 `ItemDetailDrawer`（板块 2 的点入部分）

- client 组件，**点开才 fetch**（不在 `page.tsx` 预取——6219 行全集预取太重）
- fetch `/api/admin/reports/item-detail?target_id=X&item_code=Y`
- 内容：日趋势线（`biz_date × amount`，销售/出库双线）+ 品牌分布（3120 vs 64188 横条对比）+ 类别归属卡（`category_name`/`top_category`/`item_brand`）
- 数据来源：按 `item_code` 查该商品所有 `item_num` 分品牌 × 日聚合 + `dim_item` 类别

### 3.3 `ItemOutboundList`（板块 2 的完整列表部分）

- 类 Excel 交叉表（DESIGN.md：`tabular-nums` + 维度切换 + 列头排序）
- 列：`item_name` + `category_name` + `delivery_amount` + `wholesale_amount` + `outbound_amount` + 占比%
- 筛选：`top_category`（水果/标品/耗材）下拉 + `item_brand` 下拉 + `item_name` 搜索框
- **server 端分页**（每页 50，6219 行不传 client）
- 默认按 `outbound_amount` 降序
- ⬇Excel 导出当前筛选集

### 3.4 `WholesaleCustomerReport`（板块 3）

- 3120 客户排行表：`client_name` + `wholesale_amount` + 占比% + 累计占比%
- 品品甜行高亮（`is_pinpintian=true`）+ 顶部 KPI 卡「品品甜占 3120 批发 ¥XX 万 / X%」
- ⬇Excel

### 3.5 移动端

3 板块都做 mobile 简化版：4 榜 tab 切换、列表折叠分页、客户榜单列。挂 `mobile.tsx`。

---

## 4. 数据流

### 4.1 新 lib 函数（`web/lib/report-center/`）

- `getItemBreakdownTop(targetId)` → `{ saleMonth, outboundMonth, saleDay, outboundDay }`（各 TOP20，server `ORDER BY`+`LIMIT 20`）
- `getItemOutboundListPage(targetId, page, filters)` → `{ rows, total }`（分页 50）
- `getWholesaleCustomer(targetId)` → 客户排行（含 `is_pinpintian`）

### 4.2 新 API 路由（client fetch，复用 lib）

- `POST /api/admin/reports/item-top` `{ target_id, date?, metric }` — 日榜切换
- `POST /api/admin/reports/item-list` `{ target_id, page, category?, brand?, q? }` — 列表翻页筛选
- `POST /api/admin/reports/item-detail` `{ target_id, item_code }` — 弹层

### 4.3 page.tsx 预取

`page.tsx` 预取 4 榜默认态（月榜 + 日榜默认日）+ 列表首页 + 客户榜，传 `desktop`/`mobile`。client 切换日榜日期、列表翻页、弹层按需 fetch。

---

## 5. 错误处理 / 边界

- `item_code` 100% 覆盖已验（41158 全有，合并后 6219 个，金额 2412.9 万 = 底表全量一丝不差）
- 日榜选日无数据 → 空状态「该日无商品数据」
- 弹层 `item_code` 查不到分品牌 `item_num` → 「无明细分解」
- 品品甜识别：3120 `client_name` join `dim_branch branch_name`（64188 门店）
- 数据量：月榜 server `LIMIT 20`；列表分页 50；日榜单日 `LIMIT 20`

---

## 6. 测试

- 生成器契约：`hierarchy.test.ts` 加 item/customer 视图产出非 NULL 断言
- L3b 双轨 diff：新 2 视图 vs 直查聚合表，diff=0
- lib 函数单测：`getItemBreakdownTop` 返回结构 + TOP20 顺序正确
- 前端组件快照（YAGNI，跳过）

---

## 7. 验收

| 标准 | 验证 |
|------|------|
| 4 榜可看（月/日 × 销售/出库）| `/reports/targets/[id]` 下方 2 行 2 列，日榜日期可选 |
| TOP 点入弹层 | 点商品行弹抽屉，日趋势 + 品牌分布 + 类别归属 |
| 出库商品完整列表 | 可筛分页，6219 行可翻页 |
| 批发客户 + 品品甜占比 | 3120 客户排行，品品甜行高亮 + KPI 占比 |
| 口径走 gen 视图 | 不在生成器加口径分支，`view-configs` 配置驱动 |
| 移动端 | 3 板块 mobile 简化版 |
