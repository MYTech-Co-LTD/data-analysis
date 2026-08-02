# 商品 TOP 4 独立看板重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将目标看板 `/reports/targets/[id]` 的「商品 TOP 榜」从**单卡片 2×2 切换**重构为 **4 个独立看板卡片**（月度销售/日销售/月度出库/日出库），每卡片含表头 + TOP20 + 3 行合计（TOP20小计/总合计/占比）。命名以目标日期范围（月榜）和选中日（日榜）动态渲染，跨月/非全月节假日目标不误导。

**Architecture:** 视图 `report_item_breakdown_gen` 不动（已有 sale_profit/outbound_profit 脱敏列，由生成器产出）。日榜 RPC `get_item_top_by_day` 加 2 个利润列（脱敏 CASE，迁移 145）。lib 返回结构改为 `TopBoard{rows, totalAmount, totalProfit}`，API route 同步。组件 `ItemTopBoards` 重写为 4 张独立卡片（参数化 `TopBoardCard`），命名用 `target.start_date/end_date` + `day` state。desktop/mobile 把 4 卡片插到 RegionDrillTable（战区）后、CategorySummary（类别）前。

**Tech Stack:** Next.js 15 (App Router) + TypeScript + @insforge/sdk (PostgREST RPC) + PostgreSQL 15（RPC SECURITY DEFINER + GUC 脱敏）

## Global Constraints

- **铁律**：视图口径由 view-configs + 生成器产出，**禁手写 SQL 视图**。本计划**不动视图**（`report_item_breakdown_gen` 已就绪），仅改 RPC + lib + 组件。RPC 是手写 SQL（migration 141 已是），不属视图铁律范畴，但须遵循**成本脱敏**（`CASE WHEN current_setting('request.jwt.claims.can_see_cost', true)::boolean THEN ... END`）。
- **命名禁品牌字面量**：看板命名只用日期/目标周期，不含 '3120'/'64188'/'品品甜'。
- **门店键铁律**：本计划不涉 store grain，item 视图按 `item_code` 跨品牌合并，无 branch_num 单独 join。
- **成本脱敏铁律**（postgrest-jwt-claims-guc-bug）：利润列必须 `CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN ... END`。无成本权限返 NULL，前端显示「-」。**SECURITY DEFINER 函数内 current_setting 仍读 session GUC**（pgrst_pre_request 设的 GUC 是 session 级，SECURITY DEFINER 不改 session GUC），实施时用 anon role 验证 can_see_cost=false 返 NULL。
- **DESIGN.md**：tabular-nums + DM Sans + 类 Excel 交叉表 + 每组件 chart-actions（⬇Excel/🖼图片/🔗分享）。
- **部署**：改了 RPC（迁移 145）+ 前端（lib/route/组件/page）-> **GHA push**（非纯 function 改动，必须走 GHA）。migrate.sh 重跑全部迁移，145 须幂等（`CREATE OR REPLACE FUNCTION` + GRANT 重跑无碍）。加 RPC 列后须 **restart postgrest** 刷 schema 缓存。
- **幂等**：迁移 145 用 `CREATE OR REPLACE FUNCTION`（覆盖签名），GRANT 重跑无碍。

## 命名规则（动态取数，已定）

| 看板 | 命名 | 动态值来源 |
|---|---|---|
| 月度销售商品TOP20 | `{startM}月{startD}日-{endM}月{endD}日销售商品TOP20` | `target.start_date` / `target.end_date`（已传入组件 `target` 对象） |
| 号销售商品TOP20 | `{M}月{D}号销售商品TOP20` | `day` state（默认今天/周期末/周期首，用户切日期选择器实时变） |
| 月度出库商品TOP20 | `{startM}月{startD}日-{endM}月{endD}日出库商品TOP20` | 同 target 日期范围 |
| 日出库商品TOP20 | `{M}月{D}日出库商品TOP20` | 同 day state |

- **月榜不判"是否月度"**，一律以目标日期范围命名（跨月/非全月/单月统一规则，不误导）。
- **日榜**：从 `day`（YYYY-MM-DD）提取 `new Date(day).getMonth()+1` 得月、`getDate()` 得日号。销售用"号"、出库用"日"（遵循原始命名用词）。
- **无需新增取数**：`target.start_date`/`end_date`（page.tsx 已传 `target`）+ `day` state 已具备。

## 列结构与合计行（已定）

**销售看板（4 列）**：序号 | 商品名称 | 销售金额 | 销售毛利

**出库看板（5 列）**：序号 | 商品名称 | 出库金额 | 出库毛利 | 毛利率（=毛利/金额）

**3 行合计**（每看板末尾）：
1. **TOP20小计**：TOP20 行的金额合计 + 毛利合计（出库看板附毛利率=小计毛利/小计金额）
2. **总合计**（月榜=目标周期全集合计；日榜=该日全集合计）：全量金额 + 全量毛利（出库附毛利率）
3. **TOP20占比**：TOP20金额/总金额 + TOP20毛利/总毛利（出库看板毛利率列留空或填小计毛利率）

---

## File Structure

**数据库**：
- `database/migrations/145_item_top_day_add_profit.sql` - RPC `get_item_top_by_day` 加 `sale_profit`/`outbound_profit` 列（脱敏 CASE）

**前端（web/）**：
- `web/lib/report-center/item-breakdown.ts` - `ItemTopRow` 加 profit；`TopBoard` 结构；`getItemBreakdownTop` 返回 4 个 TopBoard
- `web/app/api/admin/reports/item-top/route.ts` - 日榜返回 TopBoard（rows + totalAmount + totalProfit）
- `web/components/report-center/item-top-boards.tsx` - 重写为 4 张独立卡片（参数化 `TopBoardCard`）
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` - 4 卡片插战区后类别前；传 `target.start_date`/`end_date` 给组件
- `docs/architecture.md` - §10.11 更新（4 独立看板说明）

---

### Task 1: RPC 141 加利润列（迁移 145）

**Files:**
- Create: `database/migrations/145_item_top_day_add_profit.sql`

**Interfaces:**
- `get_item_top_by_day(p_target_id BIGINT, p_day DATE)` 返回签名扩为 7 列：`item_code TEXT, item_name TEXT, category_name TEXT, sale_amount NUMERIC, sale_profit NUMERIC, outbound_amount NUMERIC, outbound_profit NUMERIC`
- UNION 子查询加 `sale_profit`（来自 `report_daily_item_sales`）、`delivery_profit` + `wholesale_profit`（来自 `report_daily_item_outbound`）
- 最终 SELECT 利润列用脱敏 CASE：`CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(SUM(x.sale_profit),0) END AS sale_profit`，outbound_profit = delivery_profit + wholesale_profit 同样脱敏

**Why:** 日榜要展示销售毛利/出库毛利，RPC 当前只返 5 列无利润。视图已有脱敏利润列，RPC 须对齐脱敏（不能在日榜泄露成本）。SECURITY DEFINER 下 current_setting 读 session GUC（验证点）。

- [ ] **Step 1: 写迁移 145**

```sql
-- 145_item_top_day_add_profit.sql
-- 商品日榜 RPC 加利润列（sale_profit / outbound_profit），成本脱敏对齐视图。
-- 幂等：CREATE OR REPLACE FUNCTION 覆盖签名；GRANT 重跑无碍。
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(
  item_code TEXT, item_name TEXT, category_name TEXT,
  sale_amount NUMERIC, sale_profit NUMERIC,
  outbound_amount NUMERIC, outbound_profit NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT di.item_code,
    MAX(di.item_name) AS item_name,
    MAX(di.category_name) AS category_name,
    COALESCE(SUM(x.sale_amount), 0) AS sale_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(SUM(x.sale_profit), 0) END AS sale_profit,
    COALESCE(SUM(x.delivery_amount), 0) + COALESCE(SUM(x.wholesale_amount), 0) AS outbound_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(SUM(x.delivery_profit), 0) + COALESCE(SUM(x.wholesale_profit), 0) END AS outbound_profit
  FROM (
    SELECT system_book_code, item_num,
           sale_amount, sale_profit,
           NULL::numeric AS delivery_amount, NULL::numeric AS wholesale_amount,
           NULL::numeric AS delivery_profit, NULL::numeric AS wholesale_profit
    FROM report_daily_item_sales WHERE biz_date = p_day
    UNION ALL
    SELECT system_book_code, item_num,
           NULL::numeric, NULL::numeric,
           delivery_amount, wholesale_amount,
           delivery_profit, wholesale_profit
    FROM report_daily_item_outbound WHERE biz_date = p_day
  ) x
  JOIN dim_item di ON di.system_book_code = x.system_book_code
                   AND di.item_num = x.item_num
                   AND di.item_code IS NOT NULL
  WHERE EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id
                  AND p_day BETWEEN t.start_date AND t.end_date)
  GROUP BY di.item_code;
$$;
GRANT EXECUTE ON FUNCTION get_item_top_by_day(BIGINT, DATE) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 145: get_item_top_by_day 加 sale_profit/outbound_profit（脱敏）'; END $$;
```

- [ ] **Step 2: prod 跑迁移 + restart postgrest**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker cp - /opt/data-analytics-platform/deploy/ < migrations/145_item_top_day_add_profit.sql && docker exec -i deploy-postgres-1 psql -U postgres -d insforge < /dev/stdin"
# 实际用 migrate.sh 或直接 psql -f；然后 restart postgrest 刷 schema 缓存
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: 验证 RPC 返 7 列 + 脱敏生效**

```sql
-- anon role（can_see_cost 未设 -> false -> 利润列应 NULL）
SELECT * FROM get_item_top_by_day(<target_id>, '<target_period内某日>') LIMIT 3;
-- 验证 sale_profit/outbound_profit 列存在；无成本权限时为 NULL
```

---

### Task 2: lib 返回结构重构

**Files:**
- Modify: `web/lib/report-center/item-breakdown.ts`

**Interfaces:**
```typescript
export interface ItemTopRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  amount: number;
  profit: number;     // 新增：销售毛利/出库毛利（脱敏，无权限为 0 显示「-」）
  pct: number;         // 占总金额比（0-1）
}

export interface TopBoard {
  rows: ItemTopRow[];       // TOP20
  totalAmount: number;      // 全集合计金额
  totalProfit: number;      // 全集合计毛利
}

export interface ItemBreakdownTop {
  saleMonth: TopBoard;
  saleDay: TopBoard;
  outboundMonth: TopBoard;
  outboundDay: TopBoard;
  defaultDay: string;
}
```

**Why:** 组件需 TOP20 行（含 profit）+ 全集合计（给合计行）。当前结构只有 rows + pct，无 profit 和 totals。月榜从视图 SELECT 加 `sale_profit`/`outbound_profit`；日榜从 RPC（T1 加列后）取。`toTop` 改为接收 profit key，返回 profit；额外 reduce 算 totalAmount/totalProfit。

- [ ] **Step 1: 改 ItemTopRow + TopBoard 类型**
- [ ] **Step 2: 月榜 SELECT 加 `sale_profit,outbound_profit`；toTop 接收 profitKey 算 profit + totals**
- [ ] **Step 3: 日榜 RPC 返 7 列，toTop 同理算 saleDay/outboundDay 的 profit + totals**
- [ ] **Step 4: 返回 4 个 TopBoard**

注意：月榜 `saleMonth` 用 `sale_amount`/`sale_profit`，`outboundMonth` 用 `outbound_amount`/`outbound_profit`；日榜 RPC 一次返全量，前端按 metric 选 key。

---

### Task 3: API route item-top 改造

**Files:**
- Modify: `web/app/api/admin/reports/item-top/route.ts`

**Interfaces:**
- POST body 不变（`{target_id, date, metric}`）
- 返回 `{ ok: true, board: TopBoard }`（rows + totalAmount + totalProfit），前端合计行用

**Why:** 日榜切换时前端需 totals 算合计行，route 须返回 totals（不能只返 top20 rows）。RPC 已返全集，route reduce 算 totalAmount/totalProfit。

- [ ] **Step 1: RPC 返回带 profit，route map 出 amount + profit**
- [ ] **Step 2: reduce 算 totalAmount/totalProfit；top20 算 pct；返回 TopBoard**

---

### Task 4: 重写组件为 4 独立看板

**Files:**
- Modify: `web/components/report-center/item-top-boards.tsx`

**Interfaces:**
- 参数化 `TopBoardCard` 子组件：`{ title, board, columns, onPick }`，columns 区分销售(4列)/出库(5列)
- `ItemTopBoards` 渲染 4 张 `TopBoardCard`（月销售/日销售/月出库/日出库）
- 命名：月榜用 `target.start_date`/`end_date` 渲染 `{startM}月{startD}日-{endM}月{endD}日`；日榜用 `day` 渲染 `{M}月{D}号`/`{M}月{D}日`
- 日榜日期选择器：放日榜卡片标题旁（销售日榜/出库日榜共用 day state，改一个两个都变）
- 合计行：TOP20小计 / 总合计 / TOP20占比
- 保留：chart-actions（⬇Excel/🖼图片/🔗分享）+ 点商品行弹 `ItemDetailDrawer`

**Why:** 用户要 4 个独立看板（非单卡片 2×2），各带表头 + 合计行。参数化 `TopBoardCard` 避免重复（4 卡片仅列定义 + 命名 + 数据源不同）。

- [ ] **Step 1: 写 `TopBoardCard` 子组件（参数化列 + 合计行）**

```typescript
// 销售列定义
const SALE_COLS = [
  { key: 'idx', label: '序号', width: 'w-10' },
  { key: 'item_name', label: '商品名称' },
  { key: 'amount', label: '销售金额', align: 'right' },
  { key: 'profit', label: '销售毛利', align: 'right' },
];
// 出库列定义（多毛利率）
const OUTBOUND_COLS = [
  { key: 'idx', label: '序号', width: 'w-10' },
  { key: 'item_name', label: '商品名称' },
  { key: 'amount', label: '出库金额', align: 'right' },
  { key: 'profit', label: '出库毛利', align: 'right' },
  { key: 'margin', label: '毛利率', align: 'right' }, // = profit/amount
];
```

- [ ] **Step 2: 合计行计算（TOP20小计 = rows.reduce；总合计 = board.totalAmount/totalProfit；占比 = 小计/总合计）**
- [ ] **Step 3: 命名函数 `fmtRangeTitle(start,end,suffix)` + `fmtDayTitle(day,suffix)`**
- [ ] **Step 4: `ItemTopBoards` 渲染 4 卡片（2×2 grid desktop / 单列 mobile），日榜卡片标题旁放 date input**
- [ ] **Step 5: chart-actions + 弹层保留**
- [ ] **Step 6: tabular-nums + DESIGN.md 对齐**

---

### Task 5: desktop/mobile 布局调整

**Files:**
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`

**Interfaces:**
- **销售 2 看板**（月度销售+日销售）插到 `RegionDrillTable`（战区）后、`CategorySummary`（类别）前，2 看板并排（desktop 2 列 grid，mobile 单列堆叠）
- **出库 2 看板**（月度出库+日出库）插到 `CategorySummary`（类别）后、`ItemOutboundList`（出库明细）前，2 看板并排
- `ItemOutboundList`（出库明细）+ `WholesaleCustomerReport` 保持原位
- 传 `target.start_date`/`end_date` 给 `ItemTopBoards`（命名用），或组件已收 `target` 对象直接取

**Why:** 用户明确：销售看板放战区下、出库看板放类别下，同组 2 看板（月+日）并排。销售/出库分置类别两侧，主题归拢（销售主题在上，出库主题含出库明细在下）。

- [ ] **Step 1: desktop 顺序调为：KPI -> BrandMetricTable -> RegionDrillTable -> 销售TOP(月|日并排) -> CategorySummary -> 出库TOP(月|日并排) -> ItemOutboundList -> WholesaleCustomerReport**
- [ ] **Step 2: mobile 同顺序（单列堆叠，px-4 包裹；并排退化为堆叠）**
- [ ] **Step 3: 确认 `target` 对象已传 `ItemTopBoards`（命名取 start_date/end_date）**

> 实现方式：`ItemTopBoards` 组件接收 4 个 TopBoard + target，**内部**按布局渲染 2 组（销售组在上、出库组在下），每组 2 列 grid。desktop.tsx/mobile.tsx 只需在战区后、类别前各插一个 `<ItemTopBoards>` 即可--或拆成 `<SaleTopBoards>` + `<OutboundTopBoards>` 两个组件分别插战区后、类别后。倾向后者（布局位置在 page 层更显式）。

---

### Task 6: 部署 + 验证

- [ ] **Step 1: 本地 tsc + 生成器测试（无生成器改动，跑一遍确认无回归）**
- [ ] **Step 2: GHA push（迁移 145 + 前端改动）**
- [ ] **Step 3: 验证 migrate.sh 跑 145 + restart postgrest**
- [ ] **Step 4: E2E 验证**
  - API route `/api/admin/reports/item-top` 返回 TopBoard（rows + totals）
  - 页面 `/reports/targets/<id>` 渲染 4 个独立看板
  - 命名：月榜显示目标日期范围，日榜显示选中日，切日实时变
  - 合计行：TOP20小计 + 总合计 + 占比 数值正确
  - 成本脱敏：无权限用户利润列显示「-」
  - chart-actions + 弹层正常
- [ ] **Step 5: 企微客户端视觉验证（用户）**

---

## 决策记录

- **命名**：月榜用目标日期范围（`{startM}月{startD}日-{endM}月{endD}日`），不判"是否月度"--跨月/非全月/单月统一规则。日榜用选中日（`{M}月{D}号`/`{M}月{D}日`）。销售用"号"、出库用"日"。
- **出库看板位置**：出库 2 看板放 `CategorySummary`（类别）后、`ItemOutboundList`（出库明细）前；销售 2 看板放战区后类别前。同组 2 看板（月+日）并排（desktop 2 列 grid，mobile 堆叠）。
- **日榜日期选择器**：放日榜卡片标题旁，销售/出库日榜共用 day state（改一个两个都变）。
- **保留弹层**：点商品行弹 `ItemDetailDrawer`（已有，不动）。
- **视图不动**：`report_item_breakdown_gen` 已有脱敏利润列（migration 144 让 wholesale_profit 也脱敏），本次只改 RPC + 前端。
- **SECURITY DEFINER + GUC**：验证 current_setting 在 SECURITY DEFINER 函数内可读 session GUC（实施时 anon role 测 can_see_cost=false 返 NULL）。

## 风险

- **RPC 脱敏失效**：SECURITY DEFINER 若 current_setting 不可读 -> 利润列可能返 NULL 或报错。缓解：实施时验证；若失效，改 SECURITY INVOKER 或在函数内显式 `SET LOCAL`。
- **合计行数值**：totalAmount/totalProfit 须与 TOP20 小计逻辑一致（同一 reduce）。占比分母不能为 0（totalAmount=0 时占比显示「-」）。
- **部署**：迁移 145 须 restart postgrest，否则 RPC 新列 schema 缓存不刷新（GHA deploy.sh 已含 restart，但手动验证）。
