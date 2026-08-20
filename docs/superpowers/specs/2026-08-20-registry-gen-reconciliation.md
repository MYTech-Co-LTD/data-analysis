# 注册表视图命名全面对账（_v → _gen）

> 迁移：`database/migrations/204_registry_gen_reconciliation.sql`
> 日期：2026-08-20
> 状态：已修复并验证

## 背景与根因（承接 202/203 的同一系统性问题的完整暴露）

语义层视图生成器已将所有报表视图命名为 `report_*_gen`，前端（`web/lib/report-center/*`）与
push 链路全部消费 `_gen` 名。但数据注册中心 `datasets` 仍保留旧 `_v` 名（032/046 播种），
导致问数（agent-query）路由与字典指向不存在的对象：

| 注册表旧名 | 实际情况 |
|---|---|
| `report_achievement_v` | 155 已按设计 DROP；203 曾建兼容别名，但别名依赖 `report_achievement_gen`，而 generated 步骤每次部署执行 `DROP VIEW ... _gen CASCADE` → **别名被级联删除**（2026-08-20 实测：CI 后视图消失） |
| `report_region_breakdown_v` | 155 已 DROP；真实视图 = `report_region_breakdown_gen`（本次「中部战区」查询故障点） |
| `report_category_summary_v` | 155 已 DROP；真实视图 = `report_category_summary_gen` |
| `report_daily_sales_v` / `report_daily_category_v` | 155 已 DROP；真实对象 = RLS 基础表 `report_daily_sales` / `report_daily_category` |
| 8 个 `_gen` 视图（brand_metric / category_summary / item_breakdown / region_breakdown / supply_chain / wholesale_*） | 存在但**从未注册** → 问数字典缺失 |

## 关键机制教训

**不要创建依赖生成视图的别名视图**：generated 步骤对 `report_*_gen` 执行 `DROP VIEW ... CASCADE`，
依赖方（别名）会被级联删除，别名在每次部署后消失。正确姿势 = 注册表直接指向真实对象名。

## 修复内容

- 旧名注册 → 真实对象（region/category → `_gen`；daily → RLS 基础表且 exposed 置 true）；
- 删除 `report_achievement_v` 注册 + DROP 别名视图（不再重建）；
- 补注册 8 个缺失 `_gen` 视图（全部带 `scope_branch_keys()` 行级裁剪，与前端同源同值）；
- 列描述从 `information_schema` 统一播种（`is_sensitive`：列名含 cost/profit/margin/price）；
- 断言：所有 exposed pg_table 注册必须解析到真实 DB 对象。

## 权限语义

所有暴露对象均带行级权限裁剪（`_gen` 视图内嵌 `scope_branch_keys()`/`scope_brand_keys()`/
`can_cost_visible()`；daily 基础表启用 RLS + 行级 policy），与前端完全一致，无放宽。

## 验证

- 全部 exposed pg_table 注册 → 真实 DB 对象（断言通过）；
- agent-query 问数：`report_region_breakdown_gen`（战区下钻）、`report_daily_sales`、
  `report_category_summary_gen` 等均返回数据并按用户门店范围裁剪；
- CI 全量重放幂等（032 每轮播种旧名 → 204 每轮收拢）。

## 回滚

无数据破坏（仅注册表改名/登记 + DROP 一个依赖生成视图的别名）。如需回退：把注册名改回 `_v`
并重建对应视图（不推荐——与生成器架构冲突，视图每轮部署仍会被 155/generated 下线）。
