# 供应链出库层级报表 + 外部批发客户出库日报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 在目标看板 `/reports/targets/[id]` 新增 2 看板：(1) 供应链出库数据报表（四大战区->二级区域->门店 三级下钻，7 列含当天，末行合计，门店毛利率<12%标红）；(2) 外部批发客户出库报表（按日期序列，4 列，毛利率<0标红）。

**Architecture:** **生成器方案**（口径统一在 metric_registry，符合铁律）--非 RPC 手写（避免口径散落/AI 自由发挥，用户推动的正确决策）。扩展生成器加 `date grain` 能力（架构变更，已更新 architecture.md §10.10/§10.11）。看板1 用 `supplyChainOutboundView`（dim_code='branch', 三级 hierarchy, delivery metrics + daily）；看板2 用 `wholesaleDailyView`（dim_code='date', wholesale_ext metrics）。新增 3 个 metric_registry 指标。

**Tech Stack:** 语义层生成器 (services/semantic-generator, tsx + vitest) + Next.js 15 + TypeScript + PostgreSQL 15

## 需求确认（用户已定）

### 看板1：供应链出库数据报表
- 命名：`{startM}月{startD}日-{endM}月{endD}日供应链出库数据报表`
- 出库语义：仅配送 delivery（`report_daily_delivery` out_money/profit_money），与看板2批发互补
- 表头 7 列：大区名称、出库金额、出库毛利、毛利率、当天出库金额、当天出库毛利、当天毛利率
- 层级：四大战区 -> 二级区域 -> 门店（三级下钻，参考 RegionDrillTable）
- 当天：固定 current_date（closed 用 end_date = tgt.latest_day）
- 末行：门店合计
- 标红：门店行毛利率 < 12%
- 考核过滤：is_assessed_war_zone

### 看板2：外部批发客户出库报表
- 命名：`{startM}月{startD}日-{endM}月{endD}日外部批发客户出库报表`
- 客户范围：除品品甜的批发（`wholesale_ext_amount/profit`，source_filter `system_book_code='3120'`，口径在 metric_sources 数据驱动）
- 表头 4 列：时间、出库金额、出库毛利、毛利率
- 时间行：start_date ~ min(today, end_date)，每日一行（date grain，target_window 用 latest_day 上限）
- 标红：毛利率 < 0

## Global Constraints

- **铁律**：视图口径由 view-configs + 生成器产出，禁手写 SQL 视图。本计划用**生成器视图**（非 RPC），口径统一在 metric_registry。
- **date grain 架构变更**（已更新 architecture.md）：`dim_code='date'` 是生成器新能力（新 dim_code，非某指标特殊处理），符合铁律第2条（config 无法表达，须改生成器）。
- **成本脱敏**：利润/毛利率列 cost_sensitive=true，生成器自动产 CASE can_see_cost。
- **禁品牌字面量**：生成器代码不含 '3120'/'64188'。排除品品甜用 metric_sources.source_filter（数据驱动配置，非代码）。
- **门店键铁律**：看板1 store grain 含 (system_book_code, branch_num) 复合（regionBreakdownView 模式）。
- **考核过滤铁律**：看板1 delivery 只算 is_assessed_war_zone 考核门店。看板2批发全量（wholesale_ext 已限 3120）。
- **部署**：改生成器 + view-configs + 迁移 + 前端 -> GHA push。migrate.sh 重跑全部迁移（幂等）。加视图后 restart postgrest。

## File Structure

**生成器（services/semantic-generator/）**：
- `src/types.ts` - DimCode 加 'date'
- `src/generators/tier1.ts` - dimKey 加 date->biz_date；date 维度 target_window 用 latest_day 上限
- `__tests__/tier1.test.ts` - date grain 用例
- `src/view-configs.ts` - 加 supplyChainOutboundView + wholesaleDailyView
- `src/index.ts` - 注册 2 新配置
- `database/generated/report_supply_chain_outbound_gen.sql` - 生成器产出
- `database/generated/report_wholesale_daily_gen.sql` - 生成器产出

**数据库**：
- `database/migrations/146_add_daily_delivery_profit_margin.sql` - 新 metric_registry 指标（daily_delivery_profit/margin + wholesale_ext_margin，含 formula_ast）

**前端（web/）**：
- `web/lib/report-center/supply-chain-outbound.ts` - getSupplyChainOutbound（查视图）
- `web/lib/report-center/wholesale-daily.ts` - getWholesaleDaily（查视图）
- `web/components/report-center/supply-chain-outbound-table.tsx` - 三级下钻表
- `web/components/report-center/wholesale-daily-table.tsx` - 日期序列表
- `web/app/reports/targets/[id]/page.tsx` - 预取
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` - 挂 2 组件

---

### Task 1: 生成器 date grain 能力（架构变更核心）

**Files:**
- Modify: `services/semantic-generator/src/types.ts`
- Modify: `services/semantic-generator/src/generators/tier1.ts`
- Test: `services/semantic-generator/__tests__/tier1.test.ts`

**Interfaces:**
- `DimCode` 加 `'date'`
- tier1 `dimKey`：`dim_code === 'date' ? 'biz_date'`
- date 维度 target_window join：`s.biz_date BETWEEN tgt.start_date AND tgt.latest_day`（非 end_date）
- date 无 dim_table（biz_date 是 fact 列，不 cross-join dim 表）

**Why:** 看板2按日期做行（时间序列），现有 dim_code 无 'date'。这是新 dim_code（config 无法表达），属生成器能力扩展，非指标特殊处理。

- [ ] Step 1: types.ts 加 'date' 到 DimCode
- [ ] Step 2: tier1.ts dimKey 加 date->biz_date
- [ ] Step 3: tier1.ts date 维度 target_window join 用 latest_day 上限（找到所有 target_window join 处，date 时用 latest_day）
- [ ] Step 4: 写 date grain 失败测试 -> 实现 -> 通过
- [ ] Step 5: `npm test` 全绿

### Task 2: 新 metric_registry 指标（迁移 146）

**Files:** Create `database/migrations/146_add_daily_delivery_profit_margin.sql`

**Interfaces:**
- `daily_delivery_profit`：derived, cost_sensitive=true, depends_on=['delivery_profit'], formula_ast = {t:'filter', expr:{t:'ref',code:'delivery_profit'}, condition:'biz_date=tgt.latest_day'}
- `daily_delivery_margin`：derived, cost_sensitive=true, depends_on=['daily_delivery_profit','daily_delivery'], formula_ast = {t:'op', op:'/', l:{t:'ref',code:'daily_delivery_profit'}, r:{t:'ref',code:'daily_delivery'}}
- `wholesale_ext_margin`：derived, cost_sensitive=true, depends_on=['wholesale_ext_profit','wholesale_ext_amount'], formula_ast = {t:'op', op:'/', l:{t:'ref',code:'wholesale_ext_profit'}, r:{t:'ref',code:'wholesale_ext_amount'}}

**Why:** 看板1需当天出库毛利/毛利率（daily_delivery 只有金额无毛利）。看板2需批发毛利率。derived 指标改 registry AST，不动生成器（铁律第2条）。

- [ ] Step 1: 写迁移 146（INSERT metric_registry + formula_ast JSONB，ON CONFLICT DO UPDATE 幂等）
- [ ] Step 2: prod 跑迁移

### Task 3: 2 新 view-configs + 生成视图 + L3b 验证

**Files:**
- Modify: `services/semantic-generator/src/view-configs.ts`
- Modify: `services/semantic-generator/src/index.ts`
- Create: `database/generated/report_supply_chain_outbound_gen.sql`（生成器产出）
- Create: `database/generated/report_wholesale_daily_gen.sql`（生成器产出）

**Interfaces:**
- `supplyChainOutboundView`：dim_code='branch', levels=['store','sub_region','region'], hierarchy（参考 regionBreakdownView）, metrics=['delivery_amount','delivery_profit','delivery_margin','daily_delivery','daily_delivery_profit','daily_delivery_margin'], scope={target_window, assessed_war_zone, target_status:['active','closed']}, total_row=true, 无 target_metric_codes
- `wholesaleDailyView`：dim_code='date', levels=['date'], metrics=['wholesale_ext_amount','wholesale_ext_profit','wholesale_ext_margin'], scope={target_window, target_status:['active','closed']}, total_row=false

- [ ] Step 1: 写 supplyChainOutboundView（参考 regionBreakdownView hierarchy 模式，metrics 换 delivery + daily_delivery_profit）
- [ ] Step 2: 写 wholesaleDailyView（dim_code='date'）
- [ ] Step 3: index.ts 注册 2 配置
- [ ] Step 4: `npm run gen-views` 产出 2 SQL（SSH 隧道连 prod）
- [ ] Step 5: prod 跑 2 视图 + restart postgrest
- [ ] Step 6: L3b 双轨 diff=0 验证（视图 SUM vs 直查 report_daily_delivery/wholesale 聚合）

### Task 4: lib 函数

- [ ] `getSupplyChainOutbound(targetId)`：查 report_supply_chain_outbound_gen，返层级行数组
- [ ] `getWholesaleDaily(targetId)`：查 report_wholesale_daily_gen，返日期行数组

### Task 5: 前端 2 组件

- [ ] **SupplyChainOutboundTable**：三级下钻表（参考 RegionDrillTable 交互）
  - 7 列 + 末行门店合计 + 门店行毛利率<12%标红
  - 命名 fmtRangeTitle(start,end,"供应链出库数据报表")
  - chart-actions + tabular-nums
- [ ] **WholesaleDailyTable**：日期序列表
  - 4 列 + 毛利率<0标红
  - 命名 fmtRangeTitle(start,end,"外部批发客户出库报表")
  - chart-actions + tabular-nums

### Task 6: desktop/mobile 布局

**位置（用户定）：**
- 看板1 + 看板2 并排放 CategorySummary（类别）后（desktop 2 列 grid，mobile 堆叠）

- [ ] page.tsx 预取 2 数据
- [ ] desktop/mobile 挂 2 组件 + 传 target.start_date/end_date

### Task 7: 部署 + 验证

- [ ] 生成器 `npm test` 全绿
- [ ] web tsc
- [ ] GHA push（生成器 + view-configs + 迁移 146 + 前端）
- [ ] E2E：视图返数据 / 页面渲染 / 下钻 / 标红 / 脱敏 / 命名 / date grain 日期序列至当日
- [ ] 企微视觉验证（用户）

---

## 决策记录

- **方案选型**：生成器视图（非 RPC），口径统一在 metric_registry。用户推动（担忧 RPC 口径散落/AI 自由发挥），正确决策。
- **date grain 架构变更**：新 dim_code='date'，已更新 architecture.md §10.10/§10.11。属生成器能力扩展（非指标特殊处理），符合铁律第2条。
- **出库语义**：看板1=delivery（供应链向门店），看板2=wholesale_ext（除品品甜批发），互补。
- **当天**：固定 current_date（closed 用 end_date = tgt.latest_day）。
- **批发范围**：wholesale_ext（3120=除品品甜，source_filter 数据驱动）。
- **标红**：看板1 门店行毛利率<12%；看板2 行毛利率<0。
- **位置**：看板1 战区后，看板2 批发后（默认，可调）。

## 风险

- **date grain 生成器改动**：tier1 多处 target_window join，date 时全改 latest_day 上限。测试覆盖。
- **daily_delivery_profit AST**：formula_ast 的 filter 节点（参考 daily_delivery 现有 AST），生成器 astToSql 翻译成 FILTER(biz_date=latest_day)。需确认 AST 结构与 daily_delivery 一致。
- **L3b diff**：看板1 三级层级 + delivery profit + daily，对齐直查聚合。看板2 date grain 对齐直查 report_daily_wholesale WHERE 3120 按日期。
- **wholesale_ext source_filter '3120'**：metric_sources 数据驱动（非代码字面量），符合铁律。若品牌结构变（如新增第三方），改 metric_sources 数据，不动代码。
