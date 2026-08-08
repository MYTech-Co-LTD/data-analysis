# 配销比/毛利率 KPI 卡 + 下钻表比率 + 看板并排高度耦合 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 报表中心目标详情页加 2 张比率 KPI 卡（配销比现状卡 + 毛利率 12% 绝对三色卡）、品牌看板加配销比列、区域报表配销比上绝对三色、并把供应链出库与外部批发客户出库两个看板的桌面高度耦合（供应链撑开为权威、批发随高滚动）。

**Architecture:** 全部纯前端（`web/` + `DESIGN.md`），F 方案——比率 = 两个语义层已聚合分量之商，在前端相除（逐行相除 = ratio-of-sums，与生成器视图结果等价）。不改数据库、不改生成器、不改 view-configs、不重启 postgrest。比率分量已由现有视图/快照提供，无需新增任何数据字段或视图列。

**Tech Stack:** Next.js 16 (App Directory, RSC) · React 19 · TypeScript 5 · Tailwind v4 · vitest 4（lib 单测）· lucide-react。

## Global Constraints

- **F 方案铁律**：比率一律前端从现有字段相除（`actualRatio(num, den)` 等），**不得**新增视图列、不得改 `view-configs.ts`、不得改 `achievement-config.ts`/`generators/*.ts`、不得动 `target_metric_values`/`metric_definitions`。
- **closed 快照兼容**：比率分量（delivery/sale/outbound_amt/outbound_profit 及 breakdown 的 delivery_amount/sale_amount 等）已由 close_target 经 `SELECT *` 冻结，前端相除对 closed 目标同样成立。本计划不改快照机制。
- **三色规则**（DESIGN.md）：比率对比固定目标用**绝对达成率三色**（`>=1 绿 / >=0.8 琥珀 / <0.8 红 / null 灰`），**不**除时间进度（区别于现有 KPI 卡/表的相对进度 `rateColor`）。
- **数据格式**：数字列必须 `tabular-nums`；禁 emoji；金额 `>=10000` 用「X.X万」；脱敏 NULL 显示「—」。
- **测试分层**（docs/testing-handbook.md §2）：report-center lib 逻辑 → vitest 单测；UI 组件 → tsc + lint + 手动验证（无渲染单测框架）。`npm test` = `vitest run`。
- **提交**：每个 Task 末尾 `git commit`（中文 commit message，对齐仓库风格）。提交只在本地；**push 触发 GHA 部署，须用户最后显式确认**。
- **门店键**：本计划不涉及门店 join，无需复合键（仅展示现有聚合值）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `web/lib/report-center/ratio.ts` | 比率纯函数 | 新增 `marginAchievement`、`absoluteThreeColor` |
| `web/lib/report-center/__tests__/ratio.test.ts` | ratio 单测 | 新增两函数测试 |
| `web/components/report-center/kpi-cards.tsx` | KPI 卡 | 追加 2 张比率卡 |
| `web/components/report-center/brand-metric-table.tsx` | 品牌看板 | 加「配销比」列 |
| `web/components/report-center/region-drill-table.tsx` | 区域报表 | 配销比列上绝对三色（桌面+移动抽屉） |
| `web/app/reports/targets/[id]/desktop.tsx` | 桌面布局 | 供应链/批发高度耦合 |
| `web/components/report-center/supply-chain-outbound-table.tsx` | 供应链表 | 去纵向限高、改自然撑开 |
| `DESIGN.md` | 设计规范 | 记录比率三色规则 |

---

## Task 1: ratio.ts 新增纯函数（TDD）

**Files:**
- Modify: `web/lib/report-center/ratio.ts`
- Test: `web/lib/report-center/__tests__/ratio.test.ts`

**Interfaces:**
- Produces:
  - `marginAchievement(margin: number | null, target?: number): number | null`（默认 target=0.12）
  - `absoluteThreeColor(rate: number | null): string`（返回 tailwind 文本色 class）

- [ ] **Step 1: 写失败测试**

在 `web/lib/report-center/__tests__/ratio.test.ts` 末尾追加（保持现有 vitest + 中文 describe 风格，首行 import 同步加 `marginAchievement, absoluteThreeColor`）：

```ts
import { describe, it, expect } from 'vitest';
import { actualRatio, targetRatio, ratioAchievement, formatRatio, marginAchievement, absoluteThreeColor } from '../ratio';
```

文件末尾追加：

```ts
describe('marginAchievement', () => {
  it('正常 = 毛利率/目标', () => {
    expect(marginAchievement(0.18, 0.12)).toBeCloseTo(1.5);
  });
  it('默认目标 0.12', () => {
    expect(marginAchievement(0.12)).toBeCloseTo(1);
  });
  it('null 毛利率（脱敏）→ null', () => {
    expect(marginAchievement(null)).toBeNull();
  });
  it('负毛利（亏损）→ 负达成率', () => {
    expect(marginAchievement(-0.05, 0.12)).toBeCloseTo(-0.416666, 5);
  });
  it('目标 0 → null（除零保护）', () => {
    expect(marginAchievement(0.18, 0)).toBeNull();
  });
});

describe('absoluteThreeColor', () => {
  it('>=1 绿', () => {
    expect(absoluteThreeColor(1)).toBe('text-green-600');
    expect(absoluteThreeColor(1.5)).toBe('text-green-600');
  });
  it('>=0.8 琥珀', () => {
    expect(absoluteThreeColor(0.8)).toBe('text-amber-600');
    expect(absoluteThreeColor(0.99)).toBe('text-amber-600');
  });
  it('<0.8 红', () => {
    expect(absoluteThreeColor(0.79)).toBe('text-red-600');
    expect(absoluteThreeColor(0)).toBe('text-red-600');
    expect(absoluteThreeColor(-1)).toBe('text-red-600');
  });
  it('null → 灰', () => {
    expect(absoluteThreeColor(null)).toBe('text-slate-300');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run lib/report-center/__tests__/ratio.test.ts
```
Expected: FAIL（`marginAchievement is not defined` / 导入失败）。

- [ ] **Step 3: 写最小实现**

在 `web/lib/report-center/ratio.ts` 末尾追加（`formatRatio` 之后）：

```ts
// 毛利率达成率 = 毛利率 / 目标（默认 12% 全局阈值）。
// margin 为 null（成本脱敏）/ 非有限值 / target 为 0 → null。
// 用于毛利率 KPI 卡绝对三色判定。
export function marginAchievement(margin: number | null, target = 0.12): number | null {
  if (margin == null || !Number.isFinite(margin) || !target) return null;
  return margin / target;
}

// 绝对达成率三色（不除时间进度）：>=1 绿 / >=0.8 琥珀 / <0.8 红 / null 灰。
// 用于比率对比固定目标（毛利率 vs 12%、配销比 vs 配销比目标）。
// 区别于现有 KPI 卡/表的相对进度 rateColor(rate, progress)。
export function absoluteThreeColor(rate: number | null): string {
  if (rate == null) return "text-slate-300";
  return rate >= 1 ? "text-green-600" : rate >= 0.8 ? "text-amber-600" : "text-red-600";
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd web && npx vitest run lib/report-center/__tests__/ratio.test.ts
```
Expected: PASS（全部用例，含原有 actualRatio/targetRatio/ratioAchievement/formatRatio）。

- [ ] **Step 5: 提交**

```bash
git add web/lib/report-center/ratio.ts web/lib/report-center/__tests__/ratio.test.ts
git commit -m "feat(report-center): ratio.ts 加 marginAchievement/absoluteThreeColor 纯函数(毛利率达成率+绝对三色,带单测)"
```

---

## Task 2: KPI 卡追加 2 张比率卡

**Files:**
- Modify: `web/components/report-center/kpi-cards.tsx`

**Interfaces:**
- Consumes: Task 1 的 `actualRatio`、`marginAchievement`、`absoluteThreeColor`；现有 `typedRows`（`KpiRow[]`，含 sale/delivery/outbound_amt/outbound_profit 四行的 `actual_value`）。

- [ ] **Step 1: 加 import**

在 `web/components/report-center/kpi-cards.tsx` 顶部 import 区：
- 把 `import { isSuspiciousRate, suspiciousClass } from "@/lib/report-center/guard";` 改为：
```ts
import { isSuspiciousRate, isSuspiciousMargin, suspiciousClass } from "@/lib/report-center/guard";
```
- 新增一行：
```ts
import { actualRatio, marginAchievement, absoluteThreeColor } from "@/lib/report-center/ratio";
```

- [ ] **Step 2: 渲染 2 张比率卡**

在 `KpiCards` 的 return 内，`<div className="grid grid-cols-2 gap-3 md:grid-cols-4">` 里、`{METRIC_ORDER.map((code) => { ... })}` 之后、`</div>` 之前，插入：

```tsx
      {/* 比率卡（派生值，不落库）：配销比现状卡 + 毛利率(12%)绝对三色卡。
          复用 4 张金额卡的 typedRows 分量相除（逐行聚合值相除 = ratio-of-sums）。
          无 data_status 徽章（派生值，状态看 4 张源卡）、无 tooltip（副行已展示分子分母）。 */}
      {(() => {
        const sale = typedRows.find((x) => x.metric_code === "sale");
        const delivery = typedRows.find((x) => x.metric_code === "delivery");
        const outboundAmt = typedRows.find((x) => x.metric_code === "outbound_amt");
        const outboundProfit = typedRows.find((x) => x.metric_code === "outbound_profit");
        const ratioCards = [
          { key: "delivery_sale_ratio", label: "总配销比", num: delivery?.actual_value ?? null, den: sale?.actual_value ?? null, numLabel: "配送", denLabel: "销售", colored: false },
          { key: "outbound_margin", label: "毛利率", num: outboundProfit?.actual_value ?? null, den: outboundAmt?.actual_value ?? null, numLabel: "毛利", denLabel: "出库", colored: true },
        ];
        return ratioCards.map((c) => {
          // actualRatio 为通用 num/den，但仅处理 den=0；num=null（毛利脱敏）须前置守卫 → null
          const ratio: number | null = c.num == null || !c.den ? null : actualRatio(c.num, c.den);
          const susp = isSuspiciousMargin(ratio);
          const bigDisplay = ratio == null || !Number.isFinite(ratio) ? "—" : `${(ratio * 100).toFixed(1)}%`;
          const bigColor = c.colored
            ? suspiciousClass(susp, absoluteThreeColor(marginAchievement(ratio, 0.12)))
            : suspiciousClass(susp, "text-slate-800");
          const numStr = c.num == null ? "—" : fmtWan(c.num);
          const denStr = c.den == null ? "—" : fmtWan(c.den);
          return (
            <div key={c.key} className="rounded-md border p-4 text-left border-slate-200 bg-white">
              <span className="text-xs leading-tight text-slate-500">{c.label}</span>
              <div className={`mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular-nums ${bigColor}`}>
                {bigDisplay}
                {susp && <SuspiciousBadge />}
              </div>
              <div className="mt-1 text-xs tabular-nums text-slate-400">
                {c.numLabel}{numStr} / {c.denLabel}{denStr}
                {c.colored && " · 目标 12%"}
              </div>
            </div>
          );
        });
      })()}
```

- [ ] **Step 3: 类型检查 + lint + 回归测试**

```bash
cd web && npx tsc --noEmit && npm run lint && npm test
```
Expected: tsc 0 error；lint 0 error；vitest 全绿（含 Task 1 新测试）。

- [ ] **Step 4: 手动验证**

```bash
cd web && npm run dev
```
打开任一进行中目标详情页（如 `/reports/targets/<id>`），登录态查看：
- KPI 区在原 4 张金额卡后出现第 5、6 张：「总配销比」「毛利率」。
- 总配销比大号=配送/销售（如 85.3%），副行「配送X.X万 / 销售X.X万」，无三色（深灰）。
- 毛利率大号=出库毛利/出库金额，副行「毛利X.X万 / 出库X.X万 · 目标 12%」；值 `>=12%` 绿、`9.6–11.9%` 琥珀、`<9.6%` 红。
- 用无成本权限账号看：毛利率大号「—」（脱敏），副行「毛利— / 出库X」。
- 移动端（窄屏）：6 张卡 2 列自动换行，比率卡无 tooltip。

- [ ] **Step 5: 提交**

```bash
git add web/components/report-center/kpi-cards.tsx
git commit -m "feat(report-center): KPI 卡追加配销比现状卡+毛利率(12%)绝对三色卡(复用4金额卡分量前端相除)"
```

---

## Task 3: 品牌看板加「配销比」列

**Files:**
- Modify: `web/components/report-center/brand-metric-table.tsx`

**Interfaces:**
- Consumes: Task 1 的 `actualRatio`、`formatRatio`（已存在）；`BrandMetricRow.delivery_amount`、`sale_amount`（已存在）。

- [ ] **Step 1: 加 import**

在 `web/components/report-center/brand-metric-table.tsx` 顶部 import 区新增一行（该文件已 import `isSuspiciousMargin` 等 guard 函数，无需改 guard import）：

```ts
import { actualRatio, formatRatio } from "@/lib/report-center/ratio";
```

- [ ] **Step 2: frontTotals 增配销比（F3 自洽校验）**

把现有 `frontTotals` 的 `useMemo` 返回对象，在 `deliveryMargin` 之后追加一行 `deliverySaleRatio`：

```ts
    return {
      saleTarget,
      saleAmount,
      deliveryAmount,
      deliveryProfit,
      saleRate: saleTarget > 0 ? saleAmount / saleTarget : null,
      deliveryMargin:
        deliveryAmount > 0 && deliveryProfit != null
          ? deliveryProfit / deliveryAmount
          : null,
      deliverySaleRatio: saleAmount > 0 ? deliveryAmount / saleAmount : null,
    };
```

把现有 `totalAnomaly` 的 `useMemo` 返回的 `!(... && numMatch(...deliveryMargin...))` 末尾、`))` 之前追加一项（合计行配销比 = 合计行 delivery_amount/sale_amount，视图合计=总和，对比前端 SUM 之商）：

```ts
    return !(
      numMatch(frontTotals.saleTarget, vr.sale_target, 1, amountsClose) &&
      numMatch(frontTotals.saleAmount, vr.sale_amount, 1, amountsClose) &&
      numMatch(frontTotals.deliveryAmount, vr.delivery_amount, 1, amountsClose) &&
      numMatch(frontTotals.deliveryProfit, vr.delivery_profit, 1, amountsClose) &&
      numMatch(frontTotals.saleRate, vr.sale_rate, 1e-3, ratesClose) &&
      numMatch(frontTotals.deliveryMargin, vr.delivery_margin, 1e-3, ratesClose) &&
      numMatch(
        frontTotals.deliverySaleRatio,
        vr.sale_amount > 0 ? vr.delivery_amount / vr.sale_amount : null,
        1e-3,
        ratesClose,
      )
    );
```

- [ ] **Step 3: 表头加列**

在 `<thead>` 内，「配送金额」`<th>` 之后插入「配销比」`<th>`：

```tsx
                  <th className="px-3 py-2 text-right font-medium">配送金额</th>
                  <th className="px-3 py-2 text-right font-medium">配销比</th>
```

- [ ] **Step 4: 单元格加列**

在 `<tbody>` 的每行 `<tr>` 内，「配送金额」`<td>`（`{fmtCurrency(r.delivery_amount)}`）之后、「配送毛利」`<td>` 之前，插入：

```tsx
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousMargin(actualRatio(r.delivery_amount, r.sale_amount)), "text-slate-700")}`} title={suspiciousTitle(isSuspiciousMargin(actualRatio(r.delivery_amount, r.sale_amount)))}>
                    {formatRatio(actualRatio(r.delivery_amount, r.sale_amount))}
                  </td>
```

- [ ] **Step 5: 空态 colSpan 7→8**

把空态行的 `<td colSpan={7} ...>` 改为 `<td colSpan={8} ...>`。

- [ ] **Step 6: Excel 导出加列**

`handleExcel` 的 `head` 数组，在 `"配送金额"` 之后插入 `"配销比"`；`body` 的 `rows.map` 返回数组，在 `r.delivery_amount` 之后插入 `formatRatio(actualRatio(r.delivery_amount, r.sale_amount))`：

```ts
    const head = [
      "品牌",
      "销售目标",
      "销售金额",
      "销售完成率",
      "配送金额",
      "配销比",
      "配送毛利",
      "配送毛利率",
    ];
    const body = rows.map((r) => [
      r.system_book_code === "合计" ? "合计" : (r.brand_name ?? r.system_book_code),
      r.sale_target,
      r.sale_amount,
      r.sale_rate == null ? "—" : `${(r.sale_rate * 100).toFixed(1)}%`,
      r.delivery_amount,
      formatRatio(actualRatio(r.delivery_amount, r.sale_amount)),
      r.delivery_profit == null ? "—" : r.delivery_profit,
      r.delivery_margin == null ? "—" : `${(r.delivery_margin * 100).toFixed(1)}%`,
    ]);
```

- [ ] **Step 7: 类型检查 + lint + 回归测试**

```bash
cd web && npx tsc --noEmit && npm run lint && npm test
```
Expected: 全绿（brand-metric.test.ts 测的是 getter，不受组件改动影响）。

- [ ] **Step 8: 手动验证 + 提交**

`npm run dev` → 品牌看板出现「配销比」列（在配送金额与配送毛利之间），3120/64188/合计 三行均有值（如 85%），合计行 = 配送合计/销售合计。空数据时占满 8 列。

```bash
git add web/components/report-center/brand-metric-table.tsx
git commit -m "feat(report-center): 品牌看板加配销比列(配送/销售前端相除,F3自洽校验+Excel导出同步)"
```

---

## Task 4: 区域报表配销比列上绝对三色

**Files:**
- Modify: `web/components/report-center/region-drill-table.tsx`

**Interfaces:**
- Consumes: Task 1 的 `absoluteThreeColor`；现有 `ratioAchievement`、`actualRatio`、`formatRatio`；`RegionBreakdownRow` 的 `delivery_actual/sale_actual/delivery_target/sale_target`（均已存在）。

- [ ] **Step 1: 加 import**

把 `web/components/report-center/region-drill-table.tsx` 顶部的：
```ts
import { actualRatio, targetRatio, formatRatio } from "@/lib/report-center/ratio";
```
改为：
```ts
import { actualRatio, targetRatio, ratioAchievement, formatRatio, absoluteThreeColor } from "@/lib/report-center/ratio";
```

- [ ] **Step 2: 桌面「配销比」列（actual）上绝对三色**

桌面表的「配销比」`<td>`（原为纯 `text-slate-700`），把颜色 class 改为 `absoluteThreeColor(ratioAchievement(...))`。该 `<td>` 改为：

```tsx
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.ratioActual, absoluteThreeColor(ratioAchievement(node.data.delivery_actual, node.data.sale_actual, node.data.delivery_target, node.data.sale_target)))}`} title={suspiciousTitle(s.ratioActual)}>{formatRatio(actualRatio(node.data.delivery_actual, node.data.sale_actual))}</td>
```

（「配销比目标」列 `<td>` 保持纯 `text-slate-400`，不动。）

- [ ] **Step 3: 移动端抽屉「配销比」字段上绝对三色**

`buildRegionFields` 内「配销比」字段的 `color`，由 `text-slate-800` 改为绝对三色：

```ts
      { label: "配销比", value: formatRatio(actualRatio(d.delivery_actual, d.sale_actual)), color: suspiciousClass(isSuspiciousMargin(actualRatio(d.delivery_actual, d.sale_actual)), absoluteThreeColor(ratioAchievement(d.delivery_actual, d.sale_actual, d.delivery_target, d.sale_target))) },
```

- [ ] **Step 4: 类型检查 + lint + 回归测试**

```bash
cd web && npx tsc --noEmit && npm run lint && npm test
```
Expected: 全绿。

- [ ] **Step 5: 手动验证 + 提交**

`npm run dev` → 区域报表「配销比」列数值按 `actual配销比 / 该行配销比目标` 上色：`>=1 绿 / >=0.8 琥珀 / <0.8 红`；「配销比目标」列仍纯灰。展开各级（大区/小区/门店）颜色随该行实际/目标变化。移动端点行末 ▸ 抽屉里「配销比」字段同色。

```bash
git add web/components/report-center/region-drill-table.tsx
git commit -m "feat(report-center): 区域报表配销比列上绝对三色(实际配销比/行配销比目标,桌面+移动抽屉)"
```

---

## Task 5: DESIGN.md 记录比率三色规则

**Files:**
- Modify: `DESIGN.md`（「报表中心特定约定」小节）

- [ ] **Step 1: 加两条规则**

在 `DESIGN.md` 的「报表中心特定约定」列表里，紧接「毛利率标红（二元）」那条之后，追加两条：

```markdown
- **毛利率 KPI 卡（出库毛利率 vs 12%）**：绝对达成率三色 `≥12% 绿 / 9.6–11.9% 琥珀 / <9.6% 红`（脱敏 NULL 灰）。比率对比固定阈值，不除时间进度。
- **配销比报表列（vs 行配销比目标）**：绝对达成率三色 `ratioAchievement(实际/目标) ≥1 绿 / ≥0.8 琥珀 / <0.8 红`。
```

（保留原「毛利率标红（二元）：门店行毛利率 <12% 标红」那条不动——那是表格行规则，与 KPI 卡三色不冲突。）

- [ ] **Step 2: 提交**

```bash
git add DESIGN.md
git commit -m "docs(design): 记录毛利率KPI卡(12%)与配销比报表列的绝对三色规则"
```

---

## Task 6: 看板并排高度耦合（桌面）

**Files:**
- Modify: `web/components/report-center/supply-chain-outbound-table.tsx`（桌面表格容器去纵向限高）
- Modify: `web/app/reports/targets/[id]/desktop.tsx`（外部批发绝对定位填满 + 滚动）

**Interfaces:** 无新接口；纯布局 class 调整。与 Task 1–5 独立，可单独 shippable。

- [ ] **Step 1: 供应链表去纵向限高（下钻撑开）**

`web/components/report-center/supply-chain-outbound-table.tsx` 桌面表格容器（`{!isMobile && (...)}` 内的 `<div ref={tableRef} ...>`）：

把：
```tsx
        <div ref={tableRef} className="max-h-[28rem] overflow-auto">
```
改为：
```tsx
        <div ref={tableRef} className="overflow-x-auto">
```

（去掉 `max-h-[28rem]` 纵向限高 → 下钻展开时表格自然撑开驱动并排行高；保留横向滚动。sticky thead 在无纵向滚动容器下退化为普通表头。）

- [ ] **Step 2: 外部批发用绝对定位填满供应链高度并滚动**

`web/app/reports/targets/[id]/desktop.tsx` 中「供应链出库层级 + 外部批发日报」那段 `<div className="grid grid-cols-1 gap-4 md:grid-cols-2">`，把内部的 `<WholesaleDailyTable .../>` 用 `md:relative` wrapper + `md:absolute md:inset-0 md:overflow-y-auto` 内层包起来：

```tsx
      {/* 供应链出库层级 + 外部批发日报（2 看板并排；供应链高度权威，批发随高滚动） */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SupplyChainOutboundTable
          result={supplyChain}
          startDate={target.start_date}
          endDate={target.end_date}
          targetId={targetId}
        />
        <div className="md:relative">
          <div className="md:absolute md:inset-0 md:overflow-y-auto">
            <WholesaleDailyTable
              result={wholesaleDaily}
              startDate={target.start_date}
              endDate={target.end_date}
              targetId={targetId}
            />
          </div>
        </div>
      </div>
```

原理：grid 默认 `items-stretch` → 行高由供应链（有内容）决定；批发 wrapper（`md:relative`，其 `absolute` 子元素不计入高度）被 stretch 撑到行高；内层 `md:absolute md:inset-0 md:overflow-y-auto` 填满该高度并纵向滚动（thead 已 sticky 吸顶）。`md:` 前缀确保移动端退化为自然堆叠。下钻引起供应链高度变化时 grid 自动重算，无需 JS。

- [ ] **Step 3: 类型检查 + lint + build**

```bash
cd web && npx tsc --noEmit && npm run lint && npm run build
```
Expected: tsc/lint 0 error；`next build` 成功（无跨包 JSON import 问题——本计划未引入）。

- [ ] **Step 4: 手动验证 + 提交**

`npm run dev` → 桌面端「供应链出库」与「外部批发客户出库」并排：
- 两看板左右同高（高度=供应链撑开的高度）。
- 展开供应链的大区/小区 → 供应链变高，外部批发区域同步变高（grid 重算），批发内容超出则内部滚动、表头吸顶。
- 外部批发内容较短时，下方留白（card 边框填满）。
- 点外部批发某天展开客户明细 → 在同高区域内滚动，不撑高整行。
- 移动端（窄屏）：两表上下堆叠、各自自然高度（无滚动耦合）。

```bash
git add web/components/report-center/supply-chain-outbound-table.tsx web/app/reports/targets/[id]/desktop.tsx
git commit -m "feat(report-center): 供应链出库与外部批发看板桌面高度耦合(供应链去纵向限高随下钻撑开,批发绝对定位填满+随高滚动)"
```

---

## 最终验证与部署

- [ ] **全量本地门禁**

```bash
cd web && npx tsc --noEmit && npm run lint && npm test && npm run build
```
Expected: 全绿，build 成功。

- [ ] **生产部署（须用户确认后）**

本计划全部为 `web/` + `DESIGN.md` 改动 → 走 GHA：
```bash
git push origin main
```
push 后 `gh run watch <run-id>` 看 CI/CD。**不**需要 SSH 直调、不改 function、不重启 postgrest。
验证：打开 `https://data.shanhaiyiguo.com` 任一目标详情页，确认上述 6 个 Task 的手动验证项。

---

## Self-Review

**1. Spec coverage：**
- spec §1 面1（配销比 KPI 现状卡）→ Task 2 ✓
- spec §1 面2（毛利率 KPI 12% 绝对三色）→ Task 1（函数）+ Task 2（卡）✓
- spec §1 面3（品牌配销比列）→ Task 3 ✓
- spec §1 面4（区域配销比绝对三色）→ Task 4 ✓
- spec §1 面5（看板高度耦合）→ Task 6 ✓
- spec §2/§3（F 方案、closed 快照兼容）→ Global Constraints + 各 Task 均前端相除、无库改 ✓
- spec §4.5（DESIGN.md）→ Task 5 ✓
- spec §4.6（测试）→ Task 1 vitest；Task 2–6 tsc/lint/manual（对齐 testing-handbook §2 前端分层）✓
- spec §5 边界守卫（脱敏「—」、分母 0、越界 isSuspiciousMargin、负毛利）→ Task 2 ratio 计算 + bigDisplay/bigColor；Task 3/4 suspiciousClass 包裹 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤均给出完整代码与命令。

**3. Type consistency：**
- `marginAchievement(margin: number|null, target?=0.12): number|null` — Task 1 定义，Task 2 调用 `marginAchievement(ratio, 0.12)` ✓
- `absoluteThreeColor(rate: number|null): string` — Task 1 定义，Task 2/4 调用 ✓
- `actualRatio(num, den)` 现有，Task 2/3/4 调用（注意 Task 2 前置 num-null 守卫）✓
- `ratioAchievement(dA, sA, dT, sT)` 现有，Task 4 调用 ✓
- `BrandMetricRow.delivery_amount/sale_amount`、`RegionBreakdownRow.delivery_actual/sale_actual/delivery_target/sale_target` 均已存在，未新增字段 ✓
