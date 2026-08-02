# 商品视图 lateral_pick 跨账套回退匹配 设计

> **目标**：修商品视图 `report_item_breakdown_gen` 丢失 64188 品品甜批发 4.87M（致品类下钻合计≈品类看板 68%）——给生成器加 `dim_grain.lateral_pick` 能力，dim join 改为本账套优先、跨品牌回退匹配，每行恰好 1 匹配不翻倍。

## 背景（已证实，详见 [[item-view-drops-64188-wholesale-sbc-join]]）

- 底表对齐：`report_daily_item_outbound` 总额 = `report_daily_delivery` + `report_daily_wholesale`（21.24M），非采集问题。
- 商品视图 cte1 `JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num`（严复合键）。
- **64188 品品甜是熊喵外部客户**：批发记 64188 账、卖的是 3120 货（item_num 如 `312006713` 泰国金枕榴莲优级，挂 dim_item(3120)）。严 sbc join 对不上 → 64188 批发 5.50M 丢 4.87M(88%)。
- **item_num 跨品牌重叠 1519 个**（3120/64188 dim_item 各 16857/24301 行）→ 不能简单改「按 item_num 直接 join」（重叠项会翻倍）。

## 设计

### 生成器能力：`dim_grain.lateral_pick`

`ViewConfig.dim_grain` 新增可选字段：
```ts
lateral_pick?: {
  match: string;       // 匹配谓词，如 'item_num = s.item_num'
  prefer_own: string;  // 本账套优先布尔表达式，如 'system_book_code = s.system_book_code'
};
```

生成器 tier1.ts：当 `dim_grain.lateral_pick` 存在时，actual CTE 的 dim join 从
```sql
JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num
```
改为
```sql
JOIN LATERAL (
  SELECT * FROM dim_item
  WHERE item_num = s.item_num
  ORDER BY (system_book_code = s.system_book_code) DESC
  LIMIT 1
) di ON true
```
（`table` 取 `dim_item`、别名取 `di`；从现有 `dim_grain.table` 用既有 `table.split(' ')[1]` 解析别名逻辑派生表名。）

- **本账套优先**：3120 行 → 命中 dim_item(3120)（=现状，无回归）。
- **跨品牌回退**：64188 批发行（item_num 是 3120 货号）→ 本账套 64188 无 → 回退命中 dim_item(3120)。
- **不翻倍**：LIMIT 1 + ORDER BY 本账套优先，每 fact 行恰好 1 匹配（重叠 item_num 不会 2 匹配）。
- flag 闸控：未设 lateral_pick 的视图（品牌表/下钻表/批发客户表等）行为不变（仍走 `JOIN ${table} ON ${on}`）。

### view-configs：itemBreakdownView 启用 lateral_pick

```ts
dim_grain: {
  table: 'dim_item di',
  on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',  // 保留（非 lateral 默认 + 文档）
  key: 'item_code',
  extra: ['item_name', 'category_name', 'top_category', 'item_brand', 'category_group'],
  lateral_pick: { match: 'item_num = s.item_num', prefer_own: 'system_book_code = s.system_book_code' },
},
```

### 重生成 + 对账

`gen-views` 重生成 `report_item_breakdown_gen.sql`（含 LATERAL join）。prod apply + restart postgrest。
**对账验收**：`report_item_breakdown_gen` outbound 合计（target 22）应 ≈ `report_daily_delivery`+`report_daily_wholesale` 合计 21.24M（修前 14.46M）。品类下钻抽屉 SUM ≈ 品类看板单元格。

## 文件清单

| 文件 | 动作 |
|---|---|
| `docs/architecture.md` §10.10 | 已加 lateral_pick 能力条目（铁律先行） |
| `services/semantic-generator/src/types.ts` | 改：`dim_grain` 加 `lateral_pick?: {match; prefer_own}` |
| `services/semantic-generator/src/generators/tier1.ts` | 改：dim join 分支，lateral_pick 时发 LATERAL |
| `services/semantic-generator/__tests__/tier1.test.ts` | 加测试：lateral_pick 发 LATERAL + LIMIT 1 + ORDER BY prefer_own DESC；不设时仍发普通 JOIN（回归） |
| `services/semantic-generator/src/view-configs.ts` | 改：itemBreakdownView.dim_grain 加 lateral_pick |
| `database/generated/report_item_breakdown_gen.sql` | 重生成（控制器 gen-views） |

## 测试

- **vitest（TDD 先红后绿）**：
  1. 设 lateral_pick 的 config → 生成 SQL 含 `JOIN LATERAL`、`LIMIT 1`、`ORDER BY (system_book_code = s.system_book_code) DESC`、`WHERE item_num = s.item_num`。
  2. 不设 lateral_pick 的 config → 仍含 `JOIN dim_item di ON ...`（普通 join，回归不断）。
  3. （可选）断言不含重复 join 谓词。
- **生成器 tsc**：`npx tsc --noEmit`。
- **prod 对账**：gen-views 后 `SELECT SUM(outbound_amount) FROM report_item_breakdown_gen WHERE target_id=22` ≈ 21.24M；64188 批发品（榴莲/大虾）出现在商品明细且金额正确。
- **品类下钻 E2E**：点水果→抽屉商品合计 ≈ 品类看板水果单元格（修前差 32%）。

## 风险

| 风险 | 缓解 |
|---|---|
| LATERAL 性能（逐行子查询） | dim_item 上 item_num 有索引；item_outbound 行数有限（月万级）；EXPLAIN 生成期验证（L2 校验） |
| 64188 自有商品（非 3120 货）错配到 3120 | prefer_own 本账套优先；64188 货号（2126xxxx 等）在 dim_item(64188) 命中，不会回退 3120 |
| item_num 跨品牌重叠 1519 项翻倍 | LIMIT 1 严格 1 匹配；vitest 断言 LIMIT 1 |
| 影响其它视图 | lateral_pick flag 闸控，仅 item 视图启用；其余仍走普通 join（回归测试守护） |
