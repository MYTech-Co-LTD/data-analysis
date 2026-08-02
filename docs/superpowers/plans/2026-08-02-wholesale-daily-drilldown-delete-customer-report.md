# 外部批发日报·日期下钻客户明细 + 删批发客户报表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** (1) 看板2「外部批发客户出库报表」点日期行下钻到该天客户明细（client fetch，展开/折叠）；(2) 删除「批发客户报表（3120）」看板（WholesaleCustomerReport，被下钻取代）。

**Architecture:** **严格铁律--无手写 RPC/SQL 视图**。下钻需 (biz_date × client_code) 双 grain，生成器现有能力不支持（dim_code 单 dim、dim_grain 仅变换、carry_cols 是 MAX），故**扩展生成器加 `extra_grain` 能力**（actual CTE 加额外 GROUP BY 列，架构变更，已更新 architecture.md §10.10）。新视图 `report_wholesale_daily_customer_gen`（dim_code='customer' + extra_grain=['s.biz_date']，每行=该天该客户）。前端点日期 filter biz_date 取该天客户行。删 WholesaleCustomerReport 组件+lib+引用（视图 report_wholesale_customer_gen 暂保留，无引用无害）。

**Tech Stack:** 语义层生成器 (services/semantic-generator) + Next.js 15 + PostgreSQL 15

## 需求确认

### 看板2 日期下钻
- 点某天日期行 -> 展开/折叠该天客户明细
- 客户明细列：客户名称、出库金额、出库毛利、毛利率
- 数据：该天的批发客户（排除品品甜，wholesale_ext 口径）
- 标红：客户毛利率<0（延续看板2规则）

### 删除批发客户报表（3120）
- 删 `WholesaleCustomerReport` 组件 + `getWholesaleCustomer` lib + page/desktop/mobile 引用 + props
- 视图 `report_wholesale_customer_gen` 暂保留（无引用，删 view-config 会触发生成器重跑+部署，非本次必要；如要彻底清理另起任务）

## Global Constraints

- **铁律（最严）**：禁手写 SQL 视图、禁手写 RPC（本次零手写 SQL，全部生成器产出）。用户两次强调"避免 AI 自由发挥"。
- **extra_grain 架构变更**（已更新 architecture.md §10.10）：生成器加 `extra_grain?: string[]` 字段，actual CTE GROUP BY 加这些列，final SELECT 输出。属通用能力扩展（非指标特殊处理），符合铁律第2条。
- **成本脱敏**：wholesale_ext_profit/margin cost_sensitive，生成器自动产 CASE can_see_cost。
- **排除品品甜**：wholesale_ext 的 source_filter（metric_sources 数据，'3120'）已排除品品甜，视图复用 wholesale_ext 指标，无需额外处理。
- **禁品牌字面量**：view-config 不含 '3120'/'64188'（在 metric_sources 数据）。
- **部署**：改生成器 + view-configs + 前端 -> GHA push。幂等。

## File Structure

**生成器**：
- `src/types.ts` - ViewConfig 加 `extra_grain?: string[]`
- `src/generators/tier1.ts` - actual CTE GROUP BY/SELECT 加 extra_grain 列；final SELECT 输出 extra_grain
- `__tests__/tier1.test.ts` - extra_grain 用例
- `src/view-configs.ts` - 加 wholesaleDailyCustomerView
- `src/index.ts` - 注册
- `database/generated/report_wholesale_daily_customer_gen.sql` - 生成器产出

**前端**：
- `web/lib/report-center/wholesale-daily.ts` - 加 getWholesaleDailyCustomers(targetId, date)（查视图 filter biz_date）
- `web/components/report-center/wholesale-daily-table.tsx` - 加日期下钻（点行 fetch 客户明细展开）
- 删 `web/components/report-center/wholesale-customer-report.tsx`
- 删 `web/lib/report-center/wholesale-customer.ts`
- `web/app/reports/targets/[id]/page.tsx` - 删 getWholesaleCustomer 预取
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` - 删 WholesaleCustomerReport 引用 + props

**架构文档**：
- `docs/architecture.md` §10.10 - 加 extra_grain 能力说明

---

### Task 1: 生成器 extra_grain 能力（架构变更）

**Files:** types.ts + tier1.ts + 测试

**Interfaces:**
- `ViewConfig.extra_grain?: string[]`（如 `['s.biz_date']`）
- tier1 actual CTE：`selectDims`/`groupDims` 加 extra_grain 列；final SELECT 输出 extra_grain（如 `cteN.biz_date AS biz_date`）
- 与 dim_grain/carry_cols 兼容（extra_grain 是 fact 表列，直接 GROUP BY）

**Why:** 双 grain (date × client) 现有能力不支持。extra_grain 是通用"加额外 GROUP BY 列"能力（config 驱动），非指标特殊处理。

- [ ] Step 1: types.ts 加 extra_grain 字段
- [ ] Step 2: tier1.ts actual CTE GROUP BY/SELECT 加 extra_grain；final SELECT 输出
- [ ] Step 3: 写 extra_grain 测试（dim_code='customer' + extra_grain=['s.biz_date'] -> GROUP BY client_code, biz_date）
- [ ] Step 4: npm test 全绿

### Task 2: 新视图 wholesaleDailyCustomerView + 生成 + L3b

**Files:** view-configs.ts + index.ts + generated SQL

- `wholesaleDailyCustomerView`：dim_code='customer', metrics=['wholesale_ext_amount','wholesale_ext_profit','wholesale_ext_margin'], extra_grain=['s.biz_date'], carry_cols=['client_name'], scope target_window, total_row=false
- [ ] 写配置 + 注册
- [ ] gen-views 产出 SQL（SSH 隧道）
- [ ] prod 部署 + restart postgrest
- [ ] L3b diff=0（视图 SUM vs 直查 report_daily_wholesale_customer WHERE 3120 按 date+client）

### Task 3: lib 加 getWholesaleDailyCustomers

- `getWholesaleDailyCustomers(targetId, date)`：查 report_wholesale_daily_customer_gen filter target_id + biz_date=date，返客户行数组

### Task 4: 改 WholesaleDailyTable 加日期下钻

- 点日期行 -> fetch getWholesaleDailyCustomers(targetId, date) -> 展开客户明细子表
- 客户明细列：客户名称/出库金额/出库毛利/毛利率
- 标红：客户毛利率<0
- client fetch（首次点展开才加载，缓存）

### Task 5: 删 WholesaleCustomerReport

- 删组件 wholesale-customer-report.tsx + lib wholesale-customer.ts
- page.tsx 删 getWholesaleCustomer 预取 + props
- desktop/mobile 删引用 + props

### Task 6: 部署 + E2E

- npm test + tsc + GHA push
- E2E：下钻展开客户明细 / 删除后无 WholesaleCustomerReport / 脱敏 / 标红

---

## 决策记录

- **严格铁律**：零手写 SQL（无 RPC），全部生成器视图。用户两次强调避免 AI 自由发挥。
- **extra_grain 架构变更**：生成器加额外 GROUP BY 列能力（双 grain），已更新 architecture.md。属通用能力扩展。
- **下钻数据**：视图 report_wholesale_daily_customer_gen（date × client 双 grain），前端 filter biz_date 取该天客户。视图含整个周期 (date, client) 行，前端按需 filter。
- **删批发客户报表**：被看板2 下钻取代（更细粒度）。视图 report_wholesale_customer_gen 暂保留（无引用，彻底清理另起任务）。

## 风险

- **extra_grain 生成器改动**：actual CTE 多处 GROUP BY/SELECT，测试覆盖。与 dim_grain/carry_cols 兼容。
- **视图行数**：(date × client) 全周期行数 = 天数 × 客户数（几百行），前端 filter 该天。可接受。
- **L3b diff**：双 grain 对齐直查 report_daily_wholesale_customer WHERE 3120 按 (date, client)。
