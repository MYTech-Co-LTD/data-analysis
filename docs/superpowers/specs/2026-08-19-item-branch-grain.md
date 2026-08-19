# 商品粒度门店化改造（item 表加 branch 维 + RLS 补齐）

> 2026-08-19 用户裁定。状态：active（实施中）。
> spec: 本文件（迁移 200 关联）。

## 1. 背景与问题

张铎（总经理 + 范围|东部战区 69 店）验证数据收缩时发现商品 TOP 看板数据不裁剪。

诊断结论（与最初判断的差异修正）：
- 报表视图层（_gen）**没有**整体旁路 RLS——生成器在视图体内联了 `scope_match_v2`（brands + branch_nums），走 session GUC（PostgREST 每请求注入 `request.jwt.claims`），非 invoker 视图同样生效。其余看板（战区/KPI/类别/供应链/批发）branch 过滤正常。
- **真实缺口在数据模型**：`report_daily_item_sales` / `report_daily_item_outbound` 建表（迁移 107/108）时按 `(biz_date, system_book_code, item_num)` 聚合，**branch 维被聚合掉**。源 parquet 明细其实都有门店键：
  - `retail_detail.branch_num`（销售）
  - `delivery_detail.response_branch_num`（配送调入门店）
  - `wholesale_detail.branch_num`（批发销售门店）
- 后果：`report_item_breakdown_gen`（月榜）、`get_item_top_by_day`（日榜）、`get_item_detail`（明细）只过滤 brands，商品维度对区域用户显示**全店**数据。

## 2. 方案（用户已同意）

### 2.1 表结构（迁移 200）

两张 item 表重建为 branch 粒度：

```
PK (biz_date, system_book_code, branch_num, item_num)
```

破坏性操作：DROP TABLE（CASCADE 连带 drop `report_item_breakdown_gen` 视图，由 database/generated 在迁移后重建）。存量数据全量重算回填（历史 2026-07-01 起，回填前备份原表为对照）。

### 2.2 权限

- RLS：`report_rls_brand`（保留现有 185 语义）+ 新增 `report_rls_branch_nums`（复合键：`branch_num` 裸值或 `system_book_code||'-'||branch_num`，与其他报表表同款）
- 视图：`report_item_breakdown_gen` 内联 branch 过滤——生成器配置 `view-configs.ts` 删除 `perm_skip_branch: true`；`database/generated/report_item_breakdown_gen.sql` 本次手工同步补丁（与 permFilterFact('s', false) 产出逐字一致；下次连库重跑生成器应产相同结果）
- RPC：`get_item_top_by_day` / `get_item_detail`（SECURITY DEFINER 旁路 RLS）WHERE 补 `scope_match_v2('branch_nums', branch_num)`（与 brands 同款，沿用 198 的修法）

### 2.3 采集计算（report_definitions）

- item_sales：GROUP BY / mapping / conflict_keys 加 `branch_num`（取 `retail_detail.branch_num`）
- item_outbound：delivery CTE 加 `response_branch_num`，wholesale CTE 加 `branch_num`，输出统一列名 branch_num
- 全店用户语义不变：视图按 item SUM，branch 行被 RLS 放行后合计与旧口径一致

### 2.4 回填与对照（用户要求）

1. 回填前：`_backup_200_item_sales/_outbound` 全量备份原表
2. 触发 duckdb /compute 重算 item_sales / item_outbound（2026-07-01 ~ 当日）
3. 对照验证：
   - 全店口径：新表 SUM 按日/品 与备份表逐日对比，应零差异（粒度加细不改变总量）
   - 张铎口径：模拟 claims（东部战区 69 店）下商品 TOP 应只含 69 店贡献；与手工按明细口径核对

## 3. 风险与回滚

| 风险 | 处置 |
|---|---|
| 回填窗口商品 TOP 数据不全 | 选择低峰执行；compute 幂等可重跑 |
| 明细 RPC join 粒度 | get_item_detail 按日+品牌 GROUP，branch 行加细不影响输出形状 |
| 生成器漂移 | view-configs 已同步删除 skip 标记；手工补丁与生成器产出逐字对齐 |
| 回滚 | 恢复备份表 + 还原视图/RPC/定义（git revert 迁移与 generated 文件） |

## 4. 关联

- 迁移：`database/migrations/200_item_branch_grain.sql`（-- spec: 本文件）
- 生成器：`services/semantic-generator/src/view-configs.ts`（perm_skip_branch 删除）
- 先前误判修正：security_invoker/wholesale_customer 修复**不需要**（视图内联过滤本就生效、wholesale_customer_gen 已有 branch 过滤）
