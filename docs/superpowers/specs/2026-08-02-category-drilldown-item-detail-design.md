# 品类看板下钻商品明细 设计

> **目标**：品类看板（3 大类：水果/标品/耗材）行可点 → 抽屉显示该品类商品明细；删除独立的「出库商品明细」看板，其能力（搜索/排序/分页/点行→商品详情）并入下钻抽屉。

## 背景

### 现状
- **品类看板** `CategorySummary`：读 `report_category_summary_gen`，展示粗 3 类（水果/标品/耗材）+ 合计，行**不可点**。
- **出库商品明细看板** `ItemOutboundList`：独立看板，读 `report_item_breakdown_gen`，有类目筛选/搜索/排序/分页/行点开 `ItemDetailDrawer`，URL 同步。
- **商品视图口径**：`report_item_breakdown_gen` 只有**细类** `top_category`（`dim_item.top_category`，值如 `SX|生鲜`/`BP|标品`/`PK|包装耗材`），**无粗类**。

### 两个坑
1. **下钻口径错位**：品类看板是粗类（水果），商品视图是细类（SX|生鲜），不能直接筛。
2. **现有 latent bug**：`ItemOutboundList` 类目筛选按 `top_category='水果'` —— 但 top_category 实际是 `SX|生鲜` 等细类，**返 0 行**（筛选永远空）。

### 粗类映射（权威，迁移 093）
delivery/wholesale 的 `category_group`（水果/标品/耗材/其他）由 `dim_item.category_path` 派生：
```
CASE split_part(coalesce(category_path,''),'->',1)
  WHEN '生鲜' THEN '水果'
  WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
  WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
  ELSE '其他' END
```

## 设计

### 1. 数据层：dim_item 加 `category_group` 生成列（方案 B，不动生成器）

dim_item 已有 `category_path` 列（采集写入，PostgREST upsert 显式列键，加生成列安全）。新增 **STORED 生成列** `category_group`，复用 093 同款 CASE：

```sql
-- 迁移 150_dim_item_category_group.sql
ALTER TABLE dim_item
ADD COLUMN IF NOT EXISTS category_group TEXT
GENERATED ALWAYS AS (
  CASE split_part(COALESCE(category_path,''),'->',1)
    WHEN '生鲜' THEN '水果'
    WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
    WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
    ELSE '其他'
  END
) STORED;
```

- 幂等：`ADD COLUMN IF NOT EXISTS`，重跑跳过。
- 生成列表达式全 immutable（CASE+split_part+coalesce），PG15 支持。
- dim_item 经 PostgREST upsert 写（`web/lib/collect-items.ts:196`），payload 不含 category_group → 不冲突；category_path 变更时生成列自动重算。
- 把「商品→粗类」映射统一到 dim 源头（delivery/wholesale 日后可复用 `dim_item.category_group` 减少重复 CASE）。

### 2. 视图层：商品视图携带 category_group（config 改，不改生成器）

`itemBreakdownView.dim_grain.extra` 末尾加裸列名 `'category_group'`：
```ts
extra: ['item_name', 'category_name', 'top_category', 'item_brand', 'category_group'],
```
生成器已有 `MAX(di.${ex}) AS ${ex}` 机制 → 产出 `MAX(di.category_group) AS category_group`。重生成 `report_item_breakdown_gen.sql`（DROP+CREATE 幂等）+ 部署后 restart postgrest。

### 3. 前端：品类行可点 + 下钻抽屉 + 删独立看板

**`CategorySummary`（品类看板组件）改动**：
- 新增 props：`targetId: number`。
- detail 行（水果/标品/耗材）可点：`cursor-pointer` + hover + 行首 `ChevronRight` 图标 + `onClick → setDrawer(category)`。合计行不可点。
- 自持 drawer 状态（`useState<string|null>`），渲染 `<CategoryItemDrawer>`。

**新组件 `CategoryItemDrawer`**（`web/components/report-center/category-item-drawer.tsx`）：
- props：`targetId`、`category`、`onClose`。
- 右侧抽屉（Drawer 模式，复用 `ItemDetailDrawer` 的容器/遮罩风格）。
- 内容：标题（`{category}·商品明细`）+ 搜索框（商品名）+ 商品表（商品/配送/批发/出库，列排序，出库降序默认）+ 分页（每页 50）+ 行点开 `ItemDetailDrawer`。
- 取数：客户端 `fetch('/api/admin/reports/item-list', {target_id, category, page, q})`。
- **无 URL 同步**（抽屉态本地，避免污染主看板 URL）。
- 逻辑参考旧 `ItemOutboundList`（fetchPage/onSort/分页），去掉 useSearchParams/URL。

**删除**：
- `web/components/report-center/item-outbound-list.tsx`（整文件删）。
- `desktop.tsx` / `mobile.tsx`：移除 `<ItemOutboundList/>` 渲染块。
- `page.tsx`：移除 `getItemOutboundListPage(targetId,1,{})` 服务端预取 + `itemList` prop（desktop/mobile 不再接收）。

**保留**：
- `getItemOutboundListPage` lib 函数 + `/api/admin/reports/item-list` API（抽屉客户端复用），仅改筛选字段。

### 4. lib/API 筛选字段：`top_category` → `category_group`

- `web/lib/report-center/item-breakdown.ts` `getItemOutboundListPage`：`query.eq("top_category", ...)` → `query.eq("category_group", ...)`；select 列加 `category_group`，去掉/保留 `top_category`（展示用，保留）。
- `web/app/api/admin/reports/item-list/route.ts`：筛选字段同步改 `category_group`。
- `ItemOutboundListRow` 类型加 `category_group: string | null`。

## 文件清单

| 文件 | 动作 |
|---|---|
| `database/migrations/150_dim_item_category_group.sql` | 新建（dim_item 生成列） |
| `services/semantic-generator/src/view-configs.ts` | 改（itemBreakdownView.extra 加 'category_group'） |
| `database/generated/report_item_breakdown_gen.sql` | 重生成 |
| `services/semantic-generator/__tests__/` | 加测试：item 视图 extra 含 category_group |
| `web/components/report-center/category-summary.tsx` | 改（行可点 + drawer 状态 + targetId） |
| `web/components/report-center/category-item-drawer.tsx` | 新建（下钻抽屉） |
| `web/components/report-center/item-outbound-list.tsx` | **删除** |
| `web/app/reports/targets/[id]/desktop.tsx` | 改（移除 ItemOutboundList，CategorySummary 传 targetId，去 itemList prop） |
| `web/app/reports/targets/[id]/mobile.tsx` | 同上 |
| `web/app/reports/targets/[id]/page.tsx` | 改（移除 itemList 预取/prop） |
| `web/lib/report-center/item-breakdown.ts` | 改（筛选 top_category→category_group + 类型） |
| `web/app/api/admin/reports/item-list/route.ts` | 改（筛选字段 category_group） |

## 测试

- **DB**：apply 150 → `SELECT category_group, count(*) FROM dim_item GROUP BY 1`（应见 水果/标品/耗材/其他，标品含废弃档案+广西柳州）；验证 PostgREST upsert 一条 dim_item 不报生成列错。
- **生成器**：`npm run gen-views` → 产物含 `MAX(di.category_group) AS category_group`；vitest item 视图 extra 断言通过。
- **视图**：`SELECT category_group, count(*), sum(outbound_amount) FROM report_item_breakdown_gen WHERE target_id=22 GROUP BY 1`（应见粗类分布，与品类看板实际值同口径）。
- **前端**：`tsc --noEmit` + lint；企微验证：点水果→抽屉出商品（榴莲等生鲜）、点标品→标品、点耗材→耗材；搜索/排序/分页/点行→商品详情；移动端抽屉可用。
- **回归**：品类看板合计行/导出/图片不变；商品 TOP4 榜不受影响（仍用 sale/outbound amount）。

## 风险

| 风险 | 缓解 |
|---|---|
| 生成列表达式非 immutable 被 PG 拒 | CASE+split_part+coalesce 均 immutable；先本地 apply 验证 |
| dim_item 采集 upsert 写入生成列报错 | PostgREST payload 不含 category_group（新列）；采集后回填自动算；部署后跑一次采集验证 |
| 仅有出库无销售的商品（cte0 NULL）category_group 丢 | 现有 top_category 同行为；下钻按 category_group 筛，与品类看板同口径（delivery+wholesale），可接受 |
| 移动端抽屉过宽 | 抽屉用移动端全屏/底部抽屉样式（参照现有 drawer） |
