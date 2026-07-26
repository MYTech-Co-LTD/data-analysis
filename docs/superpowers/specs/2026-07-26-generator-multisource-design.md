# 语义层第二步：生成器多源扩展 设计 spec

**日期**：2026-07-26
**状态**：设计中，待用户 review（用户正在核对指标数据）
**前置**：A2 生成器（单源）+ 第一步指标重构（088/089：delivery/wholesale_pp/wholesale_ext/distribution/outbound 13 指标已声明）
**关联**：generate-views.js（单源限制在 validateView:54-69 + genLevelBranch:72-137）

---

## 1. 目标

扩展 `generate-views.js` 支持**多源视图**（base 指标来自不同 source_table），产出**配送（distribution）**和**出库（outbound）**的下钻视图——它们跨 delivery（report_daily_delivery）+ wholesale（report_daily_wholesale）两/三源。

### 非目标（YAGNI）
- 不改单源视图逻辑（store_sales_drill 等单源视图保持）
- 不支持任意 N 源复杂 JOIN（仅支持「按维度键 UNION 各源后合总」模式）

---

## 2. 现状（单源限制）

`generate-views.js` 当前：
- `validateView`：所有 base 指标必须同 `source_table`，多源报错（66-67 行）
- `genLevelBranch`：整层一个 `FROM <source_table> s JOIN dim_branch ...`（120-121 行），`SUM(s.<col>)` 取单源列
- derived 可加（outbound）直接报错（111-117 行）

所以 distribution/outbound（跨 delivery + wholesale）无法生成。

---

## 3. 多源设计

### 3.1 核心模式：UNION 各源 + 外层合总

每层（region/sub_region/store）的 SQL 结构：
```sql
SELECT
  '<level>' AS level, <parent_code>, <target_id>, <code>, <name>,
  SUM(delivery_amount)      AS delivery_amount,         -- 各源 base 合总
  SUM(wholesale_pp_amount)  AS wholesale_pp_amount,
  SUM(delivery_amount + wholesale_pp_amount) AS distribution_amount  -- derived 跨源合计
FROM (
  -- 源 1：delivery（report_daily_delivery）
  SELECT '<level>', <parent>, <tgt>, <code>, <name>,
    SUM(s.out_money) AS delivery_amount, 0 AS wholesale_pp_amount
  FROM report_daily_delivery s JOIN dim_branch dim ... JOIN targets t ... WHERE <delivery 过滤>
  GROUP BY ...
  UNION ALL
  -- 源 2：wholesale_pp（report_daily_wholesale WHERE sbc=64188）
  SELECT '<level>', <parent>, <tgt>, <code>, <name>,
    0, SUM(s.wholesale_money)
  FROM report_daily_wholesale s JOIN dim_branch dim ... JOIN targets t ... WHERE s.system_book_code='64188' AND ...
  GROUP BY ...
) combined
GROUP BY <level>, <parent>, <tgt>, <code>, <name>
```

**关键点**：
- 每源内层 SELECT：该源的 base 指标 `SUM(s.col)`，其它源 base 填 `0`（保证 UNION 列对齐 + 不串源）
- derived 跨源合计（distribution/outbound）：外层 `SUM(各依赖)` 按公式合（`delivery + wholesale_pp`）
- derived 比率（margin）若跨源不直接支持（margin 只用于同源 sale 视图，不进配送/出库视图）

### 3.2 source_filter 复用

每源内层 WHERE 套该源 base 的 `source_filter`（wholesale_pp=`s.system_book_code='64188'`，wholesale_ext=`'3120'`，delivery=NULL）。target_scoped + assessed_filter 各源都套（JOIN targets/dim_branch 在每源内层）。

### 3.3 生成器改动

1. **validateView**：移除"多源报错"，改为收集 base 按 `source_table` 分组返回 `sourceGroups`（[{table, metrics, filter}]）
2. **genLevelBranch**：重写为多源——遍历 sourceGroups 生成各源内层 SELECT（该源指标 SUM、其它 0），UNION ALL，外层合总 + derived 跨源合计
3. **derived 处理**：
   - 可加 derived（distribution/outbound）：外层 `SUM(dep1) + SUM(dep2) ...`（按 depends_on）
   - 比率 derived（margin）：仅单源视图支持（多源视图不含 margin）

---

## 4. manifest 新增

`scripts/view-manifest.json` 加两项（单源 store_sales_drill 保留）：

```json
{
  "name": "distribution_drill",
  "metrics": ["delivery_amount", "wholesale_pp_amount", "distribution_amount"],
  "dimension": "branch",
  "levels": ["region", "sub_region", "store"],
  "assessed_filter": true,
  "target_scoped": true,
  "audit": true
},
{
  "name": "outbound_drill",
  "metrics": ["delivery_amount", "wholesale_pp_amount", "wholesale_ext_amount", "outbound_amount"],
  "dimension": "branch",
  "levels": ["region", "sub_region", "store"],
  "assessed_filter": false,
  "target_scoped": true,
  "audit": true
}
```

> outbound_drill `assessed_filter=false`：外部客户（wholesale_ext）无战区，出库（含外部）不限四大战区。配送（distribution）只门店，`assessed_filter=true`。

---

## 5. 文件结构

| 文件 | 职责 |
|---|---|
| `scripts/generate-views.js`（改） | validateView 多源 + genLevelBranch 多源 UNION + derived 跨源合计 |
| `scripts/view-manifest.json`（改） | 加 distribution_drill / outbound_drill |
| `database/migrations/0NN_generated_distribution_drill.sql`（机器生成） | 配送下钻视图 + audit |
| `database/migrations/0NN_generated_outbound_drill.sql`（机器生成） | 出库下钻视图 + audit |

---

## 6. 验证

- 生成器跑通：产出 distribution_drill / outbound_drill 迁移
- 视图书据：distribution target 22 = delivery(熊喵 777万) + wholesale_pp(品品甜门店 383万) ≈ 1160万；outbound = + wholesale_ext(165万) ≈ 1325万
- audit diff=0（各层合总一致）
- 单源视图（store_sales_drill）不受影响（回归）

---

## 7. 风险/边界

1. **同 branch_num 跨源**：delivery（熊喵门店）+ wholesale_pp（品品甜门店）不同门店（两品牌），UNION 后按 (branch_num + name) GROUP，两品牌门店各一行（不合并）——符合门店唯一键 (sbc, branch_num)
2. **wholesale_ext 无门店战区**：branch_num=99（外部占位），outbound 视图 store 层会有 code=99 的"外部客户"行（或在 region 层归到 NULL/特殊战区）——要确认呈现
3. **生成器复杂度上升**：多源 UNION 比 单源 FROM 复杂，需充分测试（合成数据 + 生产 audit）
4. **manifest `assessed_filter` 差异**：配送 true（门店四大战区）、出库 false（含外部），生成器按 view 配置各源套过滤

---

## 8. 成功标准

- [ ] generate-views.js 支持多源（base 跨 source_table）
- [ ] distribution_drill 视图：delivery + wholesale_pp，三层下钻，audit diff=0
- [ ] outbound_drill 视图：+ wholesale_ext，三层下钻，audit diff=0
- [ ] 单源视图 store_sales_drill 回归不变
- [ ] 生产部署 + 数据印证（配送 ~1160万 / 出库 ~1325万）
