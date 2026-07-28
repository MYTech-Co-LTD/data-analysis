# 门店维度与品牌归属固化（branch_number + 目标管理复合键改造）

**日期**：2026-07-28
**状态**：已确认，待实现
**前置**：`dim_branch`（PK `system_book_code`+`branch_num`）、`dim_region`/`branch_full`、目标管理三级分解（063）
**关联**：`docs/superpowers/specs/2026-07-21-report-center-redesign-design.md`（品牌表的前置）、`docs/architecture.md` §3 维表

---

## 1. 背景与问题

### 1.1 根因（数据 + 代码双实证）

- **`branch_num` 跨账套重复、非唯一**。两个 lemeng 账套（3120=熊喵、64188=品品甜）各自从 1 编号，**128 个 branch_num 在两账套都存在，但对应不同物理门店**（如 branch_num=48：3120=「曲靖师宗1店」、64188=「品品甜昆明1店」）。
- 因此 **门店 = (system_book_code, branch_num)**，品牌 = system_book_code，天生确定。`dim_branch` 的 PK 已是复合键。
- 但下游多处**丢掉 system_book_code、只用 branch_num**，导致错乱：
  - `get_breakdown`（063 RPC）storeRows 不带 `system_book_code`。
  - `upsert_target_breakdown`（063 RPC）按 `WHERE branch_num=v_branch LIMIT 1` 定位/去重，并用 `SELECT system_book_code FROM dim_branch WHERE branch_num=v_branch LIMIT 1` 乱取账套 → 共享 branch_num 的两店**塌缩成一个目标、品牌被错标 3120**。
- **`docs/architecture.md:110` 把 bug 写进了文档**："门店 dim_branch 关联键 = branch_num"——需纠正。

### 1.2 后果

- `targets` 表 `system_book_code='64188'` **0 行**；parent_target_id=22 的 158 个门店级目标全标 3120。
- 回填分类（实测）：158 个门店 branch_num → **78 个仅存于 3120（熊喵，正确）；0 个仅存于 64188；79 个两账套共享（歧义）；1 个在 dim_branch 两边都查无（孤儿目标，已关/改名门店，单独清理）**。
- → **品品甜门店目标在共享号上塌缩/丢失**，无法用 system_book_code 区分品品甜门店；品品甜配送数据（在 wholesale）也无法按门店归集。
- 直接卡住：报表中心「品牌×指标表」（熊喵 vs 品品甜）做不出来。

### 1.3 账套语义（用户 2026-07-28 纠正）

`system_book_code`（账套）= **lemeng 数据源 ID**（3120=熊喵 lemeng、64188=品品甜 lemeng），**数据源层面，非财务账**。品牌 ≈ lemeng 数据源。品品甜虽隶属总部，但相对熊喵是**外部客户** → 品品甜配送走**批发明细 `report_daily_wholesale`（client_name→品品甜门店）**，不在 `report_daily_delivery`（仅采 3120）。

---

## 2. 目标

1. **门店维度单一事实源**：`dim_branch` 固化 (品牌=system_book_code, branch_num, 战区, 二级区域)，由门店采集任务自动维护。
2. **品牌确定性**：门店归属品牌由维表决定，**目标录入不出品牌选择器**（杜绝人为出错）。
3. **动态门店列表**：目标管理门店随采集变动自动更新。
4. **防再犯**：从 DB 约束、接口收口、文档、测试四层让"branch_num 单独用"变不可能/极难。
5. **解锁品牌报表**：改完后品牌 = system_book_code 全局统一，品牌×指标表可做。

---

## 3. 设计

### 3.1 门店键：复合键为真相 + 派生 branch_number 为开发键（方案 A + 派生键）

- **真相**：门店键 = `(system_book_code, branch_num)` 复合。所有底层存储/关联以此为准。`dim_branch` PK 不变。
- **开发键**：`dim_branch` 加生成列
  ```sql
  branch_number TEXT GENERATED ALWAYS AS
    (system_book_code || '-' || LPAD(branch_num, 4, '0')) STORED,
  ```
  示例 `3120-0048`、`64188-0048`。从 PK 派生 → **全局唯一、永不 stale、无需采集维护**。
- 加 `UNIQUE(branch_number)` 索引，供外部表 FK 引用。
- **不变式（写进 architecture.md + CLAUDE.md + 记忆）**：
  > `branch_num` 跨账套重复、**非全局唯一**。门店键 = `(system_book_code, branch_num)` 复合 或 派生 `branch_number`。**禁止用 branch_num 单独 join / 去重 / 做 PK / 做 `.eq()`。**

### 3.2 DB 约束（最硬护栏）

- `targets`（breakdown_level='store' 行）加 **FK `(system_book_code, branch_num)` → dim_branch(system_book_code, branch_num)`**（或经 branch_number 单列 FK）。少列/写错 → 插入失败。
- `targets` 加 `UNIQUE(parent_target_id, system_book_code, branch_num)`（where breakdown_level='store'），杜绝"一个店塌缩两行/一个店两目标"。
- 评估 `target_snapshots`、`target_metric_values`（经 target_id）是否需顺带约束。

### 3.3 目标管理改造（治根）

- **`get_breakdown`**：storeRows 每行带出 `system_book_code`、`branch_number`、`brand_name`、`war_zone`、`region_l2`；门店列表 `FROM dim_branch WHERE is_active AND branch_num<>'99'`（动态，sbc='ALL' 时两品牌都列）。共享 branch_num 的两店作为**两行**分别返回。
- **`upsert_target_breakdown`**：
  - 形参增 `p_rows` 每行带 `system_book_code`（或 `branch_number`）。
  - 定位/去重改 `WHERE parent_target_id=? AND breakdown_level='store' AND system_book_code=? AND branch_num=?`（去掉 LIMIT 1 乱取）。
  - `system_book_code` 直接用传入值，**删掉 `SELECT ... FROM dim_branch WHERE branch_num=v_branch LIMIT 1`**。
  - brand/war_zone/region_l2 从 dim_branch 继承，**UI 无品牌选择器**。
- **前端分解页**：保存 payload 每行带 system_book_code（从 get_breakdown 的 storeRows 取，用户不手选）；门店列表动态加载。

### 3.4 历史回填（targets）

- **78 个（branch_num 仅在 3120）**：保持，正确。
- **0 个（仅在 64188）**：无。
- **79 个（共享 branch_num，歧义）**：**冻结不动**，导出清单（branch_num + 3120 店名 + 64188 店名 + 现目标值）交用户逐个确认：该目标是哪一家（或两家各需独立目标）。**品品甜门店目标需在改造后按复合键重新录入**（历史已塌缩丢失，无法自动恢复）。
- **1 个（dim_branch 查无）**：孤儿目标（门店已关/改名），单独清理或归档。

### 3.5 品品甜配送（语义层）

- `metric_registry` / 口径：品品甜(64188)的**配送**指标 = `report_daily_wholesale` 中 client_name→品品甜门店（066 已有 client_name→64188 映射逻辑），**不从 `report_daily_delivery` 取**（该表仅 3120）。
- 落地形式：品牌级取数规则（视图 `report_brand_metric_v` 内按 system_book_code 分派 delivery 来源）。详见后续品牌表 spec。

### 3.6 接口收口

- 报表/前端取门店一律经视图（如 `branch_full` 扩展，暴露 `branch_number/品牌/战区/二级区域`），**不直接暴露裸 branch_num 给业务代码**。
- 新建门店相关视图/RPC 字段统一带 `branch_number`，`branch_num` 仅内部 join 用。

### 3.7 守护测试

- CI 脚本扫描：代码/迁移里 `JOIN ... ON branch_num`（不带 system_book_code）、`.eq("branch_num"`（不带 `.eq("system_book_code"`）、`WHERE branch_num=` 单列去重 → 报警。
- 回归测试：upsert 共享 branch_num 的两店目标 → 库内得两行、sbc 各自正确（防 063 回归）。

---

## 4. 影响面（需同步审计/适配）

- `report_achievement_v`（046）：join `targets`/`report_daily_*` 已用 (sbc, branch_num)，基本兼容；复核 store 级聚合。
- `report_region_breakdown_v`（073）：sale/delivery actuals 硬编码 `system_book_code='64188'`——需评估是否改为按目标品牌动态（本次只审计、记录，改动另行确认）。
- `get_targets_admin`（061）、`check_breakdown_balance`（063）：门店求和/平衡校验改复合键。
- 目标管理前端：`web/app/admin/targets/[id]`（desktop/mobile 分解页）、`web/app/api/admin/targets/breakdown/route.ts`。
- 采集 `web/lib/collect-branches.ts`：已采 system_book_code/branch_num/regions，**无需改**（branch_number 是生成列自动派生）。

---

## 5. 迁移与部署

- 迁移幂等：`ADD COLUMN IF NOT EXISTS ... GENERATED ALWAYS AS`、`ADD CONSTRAINT IF NOT EXISTS`、FK 先清脏数据再加。
- 加 branch_number 生成列需重写表（PG 生成列加列会 rewrite），387 行小表可接受。
- **回填 79 歧义行前不加可能冲突的约束**；FK 落地前确保无 dangling (sbc,branch_num)。
- 改动 `database/` + `web/`(前端+RPC 调用) → **GHA 全量部署**；迁移后 `docker compose restart postgrest` 刷 schema 缓存。
- 受 CLAUDE.md「采集任务数据完整性规则」与「架构先行」约束：本 spec 落地后同步更新 `docs/architecture.md` §3 与 CLAUDE.md。

---

## 6. 风险

1. **历史品品甜目标丢失**：79 共享号目标语义不可恢复 → 需用户复核 + 重录，期间品牌达成率不完整。
2. **region_breakdown_v 硬编码 64188**：与"按目标品牌动态"冲突，本次仅记录、不擅改。
3. **下游遗漏**：branch_num-only 的隐藏用法可能未扫全 → 守护测试 + 审计兜底。
4. **FK 加列锁表**：小表(387)影响可忽略；生产低峰执行。

---

## 7. 不做（YAGNI）

- 不引入独立 `brand_code` 列（品牌 = system_book_code，已有 dim_brand 映射）。
- 不复用 `branch_id`（虽全局唯一但采集未维护、会 stale；生成列 branch_number 更稳）。
- 不在本 spec 实现品牌×指标表（单独 spec，依赖本改造 + 品品甜目标重录）。
- 不做预警机制（report-center-redesign Phase 4）。
