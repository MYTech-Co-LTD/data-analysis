# 达成率视图注册表命名漂移修复（report_achievement_v → report_achievement_gen）

> 迁移：`database/migrations/202_report_achievement_gen_registry.sql`
> 日期：2026-08-20
> 状态：已修复并验证

## 背景与根因

智能问数（agent-query）查询目标达成率报「表不存在：report_achievement_v」。

链路调查：
- 前端（`web/lib/report-center/targets.ts`）与 push 链路（`web/lib/push/index.ts`）早已读取
  **`report_achievement_gen`**——语义层视图生成器把达成率视图重命名为此（security_invoker +
  `scope_branch_keys()`/`scope_brand_keys()`/`can_cost_visible()` 权限强制），DB 中不再存在
  `report_achievement_v`（仅剩 `report_achievement_gen` 与 QA 副本 `_gen_qa`）。
- 但**数据注册中心**（`datasets` 行 + `dataset_columns` 关联，046 播种）与 **admin RPC**
  （`get_targets_admin`，048 函数体）仍指向旧名 `report_achievement_v`。
- agent-query 的 PG 路由与 `list_datasets` 字典都读 `datasets` 注册表 → 旧名 → 「表不存在」。
- 附带影响：admin 目标页（`web/app/api/admin/targets/route.ts` GET → `get_targets_admin`）同样报错。

## 修复内容

三处旧名统一同步为 `report_achievement_gen`：

1. `datasets`：INSERT 新名行（复制旧行元数据，`ON CONFLICT (name) DO NOTHING` 幂等）→
   `dataset_columns` 关联迁移到新名（FK：`dataset_columns.dataset_name → datasets.name`）→ DELETE 旧行。
   顺序要点：先建父行 → 迁子行 → 删父行（FK 约束决定）。
2. `get_targets_admin` RPC：函数体 `report_achievement_v` → `report_achievement_gen`
   （SECURITY DEFINER 语义不变，GRANT 不变）。
3. `openclaw/data-query-plugin/skills/retail-query/SKILL.md`：4 处旧表名 → 新名
   （防止模型按旧名查询再次报错）。

`dataset_columns` 内容已与 gen 视图一致（17 列含 metric_code/target_value/actual_value/
achievement_rate/progress_rate），无需重刷。

## 权限语义

`report_achievement_gen` 为 security_invoker 视图，内部用 `scope_branch_keys()`（门店）、
`scope_brand_keys()`（品牌）、`can_cost_visible()`（成本列）裁剪——问数暴露后行级/列级
权限与前端一致，无放宽。

## 验证

- `datasets` 注册行 = `report_achievement_gen`（pg_table / summary / exposed=t）。
- `get_targets_admin()` 返回 8 行（admin 视角）。
- agent-query（Bearer openclaw:query JWT）：
  - dictionary 含 `report_achievement_gen`（目标达成率(三态)）；
  - `SELECT name, metric_name, status, target_value, actual_value, achievement_rate
     FROM report_achievement_gen WHERE target_level='total'` 返回真实数据
    （8 月销售：target 6,873,288 / actual 4,237,292 / 61.65%），engine=pg，按 ZhangDuo 门店范围裁剪。

## 回滚

无破坏性风险（仅注册表改名 + 函数体替换；视图未删）。如需回退：
- `datasets`/`dataset_columns` 改回 `report_achievement_v` 并重建同名视图（若后续视图再改名）；
- `get_targets_admin` 函数体指回原视图。
