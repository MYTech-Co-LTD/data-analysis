# 目标管理 UI 靠拢 / 术语治理 / 配销比 / 批量导入预览 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 录入端向报表端视觉靠拢 + 治理术语 + 新增配销比（双端）+ Excel 导入 diff 预览 + 清理设置页/死代码。

**Architecture:** 前端 + 1 个 DB 术语同步迁移（077，纯 UPDATE 幂等）+ 架构文档。可测逻辑（配销比、diff 比对）抽成纯函数 + vitest 单测；UI 文案/样式用精确字符串替换 + `next build` 验证；DB 迁移走 GHA migrate（按文件名顺序重跑，077 在 068/076 之后覆盖其 seed）。

**Tech Stack:** Next.js 16 + React 19 + Tailwind v4 + lucide-react + vitest + xlsx + html2canvas + sonner。

## Global Constraints

- **遵循 DESIGN.md**：中性色用 slate（禁 gray）、lucide 图标（禁 emoji/字符 ▼▶）、数字 `tabular-nums`、达成率三色编码（绿≥1/琥珀≥0.8/红<0.8）；配销比例外用中性色（结构指标，非越高越好）。
- **术语改 UI 文案 + Excel 表头 + DB 显示名**（`metric_definitions.name` / `metric_registry.name`），不动 `metric_code` / 视图列名 / 前端变量名 / RPC 参数。
- **配销比不落库**：sale/delivery 的派生值，前端计算。
- **cwd**：所有前端命令在 `web/` 目录下执行。
- **测试**：纯函数 `npm test`（vitest）；UI 改动 `npm run build` 验证编译。
- **commit**：每个 task 末尾 commit，conventional commits（`feat(targets):` / `style(targets):` / `chore:` / `docs:`）。
- **DB 迁移 077**：纯 UPDATE 幂等，不改表结构，无需 restart postgrest；migrate.sh 按文件名顺序重跑，077 > 076/068 故在其后执行、覆盖 seed 值。
- **部署**：全部完成后 `git push origin main` 触发 GHA（含 DB 迁移；不动 functions，无需 SSH 直调）。
- **不主动 push**：CLAUDE.md 规定 commit only when user asks；本 plan 只 commit 到本地，push 由用户决定。

**Spec**：`docs/superpowers/specs/2026-07-27-target-ui-term-governance-design.md`

---

## Task 1: 配销比纯函数 + 单测（TDD）

**Files:**
- Create: `web/lib/report-center/ratio.ts`
- Test: `web/lib/report-center/__tests__/ratio.test.ts`

**Interfaces:**
- Produces: `targetRatio(delivery, sale)`, `ratioAchievement(dActual, sActual, dTarget, sTarget)`, `formatRatio(r)` — 供 Task 5（达成端列）、Task 8/9（录入端列/chip/modal）使用。

- [ ] **Step 1: 写失败测试**

创建 `web/lib/report-center/__tests__/ratio.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { targetRatio, ratioAchievement, formatRatio } from '../ratio';

describe('targetRatio', () => {
  it('正常比值', () => {
    expect(targetRatio(2000, 5000)).toBeCloseTo(0.4);
  });
  it('销售目标为 0 返回 null（除零）', () => {
    expect(targetRatio(2000, 0)).toBeNull();
  });
  it('配送为 0 返回 0', () => {
    expect(targetRatio(0, 5000)).toBe(0);
  });
});

describe('ratioAchievement', () => {
  it('正常 = 实际配销比/目标配销比', () => {
    // actual 2250/4500=0.5, target 2000/5000=0.4 → 1.25
    expect(ratioAchievement(2250, 4500, 2000, 5000)).toBeCloseTo(1.25);
  });
  it('目标销售为 0 → null', () => {
    expect(ratioAchievement(100, 200, 100, 0)).toBeNull();
  });
  it('实际销售为 0 → null', () => {
    expect(ratioAchievement(100, 0, 100, 200)).toBeNull();
  });
});

describe('formatRatio', () => {
  it('null → —', () => {
    expect(formatRatio(null)).toBe('—');
  });
  it('0.4 → 40%', () => {
    expect(formatRatio(0.4)).toBe('40%');
  });
  it('1.128 → 113%（toFixed0 四舍五入）', () => {
    expect(formatRatio(1.128)).toBe('113%');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npm test -- ratio`
Expected: FAIL（`Cannot find module '../ratio'`）

- [ ] **Step 3: 实现 ratio.ts**

创建 `web/lib/report-center/ratio.ts`：
```ts
// 配销比 = 配送 / 销售。派生值，不落库。
// 目标配销比用目标值；配销比达成率 = 实际配销比 / 目标配销比。

export function targetRatio(deliveryTarget: number, saleTarget: number): number | null {
  if (!saleTarget) return null;
  return deliveryTarget / saleTarget;
}

// 配销比达成率 = (deliveryActual/saleActual) / (deliveryTarget/saleTarget)
export function ratioAchievement(
  deliveryActual: number, saleActual: number,
  deliveryTarget: number, saleTarget: number,
): number | null {
  if (!saleTarget || !saleActual) return null;
  return (deliveryActual / saleActual) / (deliveryTarget / saleTarget);
}

export function formatRatio(r: number | null): string {
  if (r == null) return '—';
  return (r * 100).toFixed(0) + '%';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npm test -- ratio`
Expected: PASS（3 describe 全绿）

- [ ] **Step 5: Commit**

```bash
git add web/lib/report-center/ratio.ts web/lib/report-center/__tests__/ratio.test.ts
git commit -m "feat(targets): 加配销比计算纯函数+单测"
```

---

## Task 2: Excel 导入 diff 比对纯函数 + 单测（TDD）

**Files:**
- Create: `web/lib/report-center/import-diff.ts`
- Test: `web/lib/report-center/__tests__/import-diff.test.ts`

**Interfaces:**
- Produces: `diffImport(currentRows, incomingRows)` → `DiffEntry[]`，供 Task 7（diff modal）使用。
- `TargetMetricRow` = `{ branch_num: string; branch_name?: string; metrics: Record<string, number> }`（metrics 键为 `sale`/`delivery`）。
- `DiffEntry` = `{ branch_num; branch_name; metric; oldValue; newValue; diff }`，仅含有变更的格。

- [ ] **Step 1: 写失败测试**

创建 `web/lib/report-center/__tests__/import-diff.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { diffImport } from '../import-diff';

describe('diffImport', () => {
  const current = [
    { branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
    { branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } },
  ];

  it('只返回变更格', () => {
    const incoming = [
      { branch_num: '001', branch_name: 'A店', metrics: { sale: 5500, delivery: 2000 } }, // sale 变
      { branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } }, // 没变
    ];
    const d = diffImport(current, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ branch_num: '001', metric: 'sale', oldValue: 5000, newValue: 5500, diff: 500 });
  });

  it('新增门店（当前无）也算变更', () => {
    const incoming = [
      { branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
      { branch_num: '003', branch_name: 'C店', metrics: { sale: 8000, delivery: 0 } },
    ];
    const d = diffImport(current, incoming);
    expect(d.find(x => x.branch_num === '003' && x.metric === 'sale')).toMatchObject({ oldValue: 0, newValue: 8000 });
  });

  it('空 incoming 返回空数组', () => {
    expect(diffImport(current, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npm test -- import-diff`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 import-diff.ts**

创建 `web/lib/report-center/import-diff.ts`：
```ts
// Excel 导入 diff：对比当前 branchRows 与导入 rows，返回有变更的格。
// 按 branch_num + metric 对比；当前不存在的门店视为 0（新增）。

export interface TargetMetricRow {
  branch_num: string;
  branch_name?: string;
  metrics: Record<string, number>;
}

export interface DiffEntry {
  branch_num: string;
  branch_name?: string;
  metric: string;
  oldValue: number;
  newValue: number;
  diff: number;
}

export function diffImport(
  current: TargetMetricRow[],
  incoming: TargetMetricRow[],
  metrics: string[] = ['sale', 'delivery'],
): DiffEntry[] {
  const curMap = new Map(current.map(r => [r.branch_num, r]));
  const diffs: DiffEntry[] = [];
  for (const inc of incoming) {
    const cur = curMap.get(inc.branch_num);
    for (const m of metrics) {
      const oldVal = Number(cur?.metrics?.[m]) || 0;
      const newVal = Number(inc.metrics?.[m]) || 0;
      if (oldVal !== newVal) {
        diffs.push({
          branch_num: inc.branch_num,
          branch_name: inc.branch_name ?? cur?.branch_name,
          metric: m,
          oldValue: oldVal,
          newValue: newVal,
          diff: newVal - oldVal,
        });
      }
    }
  }
  return diffs;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npm test -- import-diff`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/report-center/import-diff.ts web/lib/report-center/__tests__/import-diff.test.ts
git commit -m "feat(targets): 加 Excel 导入 diff 比对纯函数+单测"
```

---

## Task 3: 术语治理（前端 label + DB 迁移 077 + 架构文档）

**Files:**
- Modify: `web/lib/report-center/metric-source.ts:19-24`（METRICS.label）
- Create: `database/migrations/077_term_governance.sql`
- Modify: `docs/architecture.md` §10.8

**Interfaces:** 无（label/name 是展示字符串；metric_code、视图列名、变量名均不变）。

- [ ] **Step 1: 改 metric-source.ts label**

`web/lib/report-center/metric-source.ts` 的 `METRICS` 对象，4 个 label 改：
```ts
export const METRICS: Record<MetricCode, MetricMeta> = {
  sale:            { code:"sale",            label:"销售",         unit:"元", trendTable:"report_daily_sales",    trendValueCol:"total_sale" },
  delivery:        { code:"delivery",         label:"配送",         unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money" },
  outbound_amt:    { code:"outbound_amt",     label:"出库金额",     unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_money", categoryIn:["水果","标品耗材"] },
  outbound_profit: { code:"outbound_profit",  label:"出库毛利",     unit:"元", trendTable:"report_daily_delivery", trendValueCol:"profit_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_profit", categoryIn:["水果","标品耗材"] },
};
```
（其余字段不变，只改 label 4 处：`门店零售→销售`、`门店配送→配送`、`总仓出库金额→出库金额`、`总仓出库毛利→出库毛利`）

- [ ] **Step 2: 新建 DB 术语同步迁移 077**

创建 `database/migrations/077_term_governance.sql`：
```sql
-- 077_term_governance.sql
-- 术语治理：delivery 统一「配送」（不再叫出库），outbound 专指「出库」(=配送+批发)
-- 同步 metric_definitions.name（智能问数 metric_name 显示用）+ metric_registry.name（语义层）
-- 修 metric_registry 里 delivery_amount='出库金额' 与 outbound_amount 撞名的 bug
-- 幂等：纯 UPDATE。migrate.sh 按文件名重跑，077 在 068/076 之后执行、覆盖其 seed 值。

UPDATE metric_definitions SET name='销售'   WHERE metric_code='sale';
UPDATE metric_definitions SET name='配送'   WHERE metric_code='delivery';
UPDATE metric_definitions SET name='出库金额' WHERE metric_code='outbound_amt';
UPDATE metric_definitions SET name='出库毛利' WHERE metric_code='outbound_profit';

UPDATE metric_registry SET name='配送金额' WHERE metric_code='delivery_amount';
UPDATE metric_registry SET name='配送毛利' WHERE metric_code='delivery_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 077_term_governance completed'; END $$;
```
说明：`metric_registry` 的 `sale_amount`(销售金额) / `wholesale_*`(批发) / `outbound_amount`(总出库金额) 术语已正确，不动；仅修 delivery 两处撞名。本地验证（可选）：`docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code,name FROM metric_definitions WHERE metric_code IN ('sale','delivery','outbound_amt','outbound_profit');"`。GHA 部署自动跑。

- [ ] **Step 3: 更新架构文档 §10.8**

`docs/architecture.md` §10.8「目标与达成子系统」：
1. 品类定义修正：把文档里「水果/标品耗材」改为 **水果/标品/耗材（3 类）**（搜索 `标品耗材` 在 §10.8 出现处，按上下文改为 3 类）
2. 在 §10.8 末尾加「权威术语表」小节：
```markdown
**权威术语表**（UI 展示统一，metric_code/字段名不变）：
- sale = 销售（门店维度：门店销售/月销售）
- delivery = 配送（门店维度：门店配送/月配送）；**不再叫"出库"**
- wholesale = 批发
- outbound_amt = 出库金额（= 配送 + 批发，总部总仓全部出货）
- outbound_profit = 出库毛利
- 配销比 = 配送/销售；配销比达成率 = 实际配销比/目标配销比（前端派生不落库）
```

- [ ] **Step 4: build 验证**

Run: `cd web && npm run build`
Expected: 编译通过（label 改动不影响类型）

- [ ] **Step 5: Commit**

```bash
git add web/lib/report-center/metric-source.ts database/migrations/077_term_governance.sql docs/architecture.md
git commit -m "docs(targets): 术语治理-sale/delivery/outbound权威命名+DB迁移077+架构§10.8品类修正"
```

---

## Task 4: KpiCards 修复 + desktop/mobile 删 focus + loading 清注释

**Files:**
- Modify: `web/components/report-center/kpi-cards.tsx`（着色口径 + 删 focus）
- Modify: `web/app/reports/targets/[id]/desktop.tsx:80`
- Modify: `web/app/reports/targets/[id]/mobile.tsx:81`
- Modify: `web/app/reports/targets/[id]/loading.tsx:29`

**Interfaces:**
- Consumes: KpiCards 的调用方（desktop/mobile）不再传 `focus`/`onFocus`。
- Produces: `KpiCards({ rows })`（纯展示，无 focus 接口）。

- [ ] **Step 1: 改 kpi-cards.tsx**

`web/components/report-center/kpi-cards.tsx`：

① 删 focus 相关。组件签名（约 line 73-81）改为：
```tsx
export function KpiCards({
  rows,
}: {
  rows: KpiRow[];
}) {
```
（删 `focus` / `onFocus` 参数与类型）

② 删 `isFocus` 判定与点击态。渲染处（约 line 91-107）：
- 删 `const isFocus = focus === code;`
- `<button ... onClick={() => onFocus(code)} className={... isFocus ? ...}>` → `<div className="rounded-md border p-4 text-left transition relative group border-slate-200 bg-white hover:border-slate-300">`（去掉 button/onClick/isFocus 三元）

③ 着色口径修正（约 line 118-123）。大数字 className 改为按绝对达成率着色：
```tsx
<div
  className={`mt-1 text-2xl font-semibold tabular-nums ${rateColor(
    r.achievement_rate ?? 0,
  )}`}
>
  {((r.achievement_rate ?? 0) * 100).toFixed(1)}%
</div>
```
（原为 `rateColor((r.achievement_rate ?? 0) / (progress || 0.0001))`，去掉除以 progress）

- [ ] **Step 2: desktop.tsx 删 focus 传参**

`web/app/reports/targets/[id]/desktop.tsx:80`：
```tsx
      <KpiCards rows={kpi} />
```
（原为 `<KpiCards rows={kpi} focus="sale" onFocus={() => {}} />`）

- [ ] **Step 3: mobile.tsx 删 focus 传参**

`web/app/reports/targets/[id]/mobile.tsx:81`：
```tsx
        <KpiCards rows={kpi} />
```

- [ ] **Step 4: loading.tsx 清 GaugeChart 注释**

`web/app/reports/targets/[id]/loading.tsx:29` 删除该行 `{/* GaugeChart 达成 */}`（整行删）。

- [ ] **Step 5: build 验证**

Run: `cd web && npm run build`
Expected: 通过（确认无残留 focus 引用）

- [ ] **Step 6: Commit**

```bash
git add web/components/report-center/kpi-cards.tsx web/app/reports/targets/[id]/desktop.tsx web/app/reports/targets/[id]/mobile.tsx web/app/reports/targets/[id]/loading.tsx
git commit -m "fix(targets): KPI 着色口径统一为绝对达成率+删 focus 死代码"
```

---

## Task 5: RegionDrillTable 增强（术语 + 配销比列 + ChartActions + lucide + head 空格）

**Files:**
- Modify: `web/components/report-center/region-drill-table.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ratioAchievement` / `formatRatio`；`chart-actions` 的 `exportImage`。
- Produces: RegionDrillTable 多一列「配销比」、ChartActions 三按钮。

- [ ] **Step 1: import 补充**

文件顶部 import 加：
```tsx
import { useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ratioAchievement, formatRatio } from "@/lib/report-center/ratio";
```
（`ChartActions, exportExcel` 已 import；新增 `exportImage`：`import { ChartActions, exportExcel, exportImage } from "./chart-actions";`）

- [ ] **Step 2: 组件加 ref**

`RegionDrillTable` 函数体首行加：
```tsx
const tableRef = useRef<HTMLDivElement>(null);
```
外层返回的 `<div className="rounded-lg border ...">` 加 `ref={tableRef}`。

- [ ] **Step 3: 折叠图标字符 → lucide**

约 line 129-135 的 `{isExpanded ? "▼" : "▶"}` 改为：
```tsx
{isExpanded ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
```

- [ ] **Step 4: 术语（月出库 → 月配送）**

- 表头（约 line 229-231）：`月出库目标 / 月出库金额 / 月出库完成率` → `月配送目标 / 月配送金额 / 月配送完成率`
- 表标题（约 line 217）：`{targetMonth}月门店零售/出库数据报表` → `{targetMonth}月门店零售/配送数据报表`
- Excel head（约 line 196-202）：`月出库目标/月出库金额/月出库完成率` → `月配送目标/月配送金额/月配送完成率`；**同时修前导空格**：所有 `" 销售金额"`→`"月销售金额"`、`" 月销售金额"`→`"月销售金额"`（去掉所有 head 元素的前导空格，统一为无前导空格）

- [ ] **Step 5: 加配销比列**

表头（约 line 224-236 `<tr>`）末尾加一列（在「剩余日均出库目标」th 后）：
```tsx
<th className="px-3 py-2 text-right font-medium">配销比</th>
```
（注意把原 `<tr>` 内所有 th 的前导空格清掉）

渲染行 `renderRows`（约 line 123-176）的每行末尾（「剩余日均出库目标」td 后）加一列。主数字=配销比达成率，副小字=目标配销比，中性色 slate（不用三色）：
```tsx
<td className="px-3 py-2 text-right tabular-nums text-slate-500">
  <div className="text-sm">
    {formatRatio(ratioAchievement(node.data.delivery_actual, node.data.sale_actual, node.data.delivery_target, node.data.sale_target))}
  </div>
  <div className="text-[10px] text-slate-400">
    {formatRatio((() => { const t = node.data.sale_target; return t ? node.data.delivery_target / t : null; })())}
  </div>
</td>
```

`colSpan` 空状态（约 line 241）由 `11` → `12`。

- [ ] **Step 6: ChartActions 补图片/分享**

`handleExcel` 定义后（约 line 211），加：
```tsx
const handleImage = () => {
  if (tableRef.current) exportImage(tableRef.current, `${targetMonth}月门店零售配送报表`);
};
const handleShare = async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    const { toast } = await import('sonner');
    toast.success('链接已复制');
  } catch { /* 剪贴板拒绝时静默 */ }
};
```
标题栏 `<ChartActions onExcel={handleExcel} />`（约 line 219）改为：
```tsx
<ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
```

- [ ] **Step 7: min-w 加宽**

`overflow-x-auto` 内 `<table>` 若有 `min-w` 约束则 +100px（当前无显式 min-w，跳过）。

- [ ] **Step 8: build 验证**

Run: `cd web && npm run build`
Expected: 通过

- [ ] **Step 9: Commit**

```bash
git add web/components/report-center/region-drill-table.tsx
git commit -m "feat(targets): RegionDrillTable 加配销比列+图片分享导出+lucide图标+术语"
```

---

## Task 6: CategorySummary（head 空格 + ChartActions）

**Files:**
- Modify: `web/components/report-center/category-summary.tsx`

- [ ] **Step 1: import + ref**

顶部 import 加 `useRef`、`exportImage`：
```tsx
import { useRef } from "react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
```
组件首行加 `const tableRef = useRef<HTMLDivElement>(null);`，外层 div 加 `ref={tableRef}`。

- [ ] **Step 2: 修 Excel head 前导空格**

`handleExcel` 的 head 数组（约 line 28-32）：所有元素去掉前导空格（`" 月销售目标"`→`"月销售目标"`，全 12 个元素）。

- [ ] **Step 3: ChartActions 补图片/分享**

`handleExcel` 后加：
```tsx
const handleImage = () => { if (tableRef.current) exportImage(tableRef.current, `${targetMonth}月仓储出库报表`); };
const handleShare = async () => {
  try { await navigator.clipboard.writeText(window.location.href); const { toast } = await import('sonner'); toast.success('链接已复制'); } catch {}
};
```
`<ChartActions onExcel={handleExcel} />`（约 line 49）改为 `<ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />`。

- [ ] **Step 4: build + commit**

Run: `cd web && npm run build`（Expected: 通过）
```bash
git add web/components/report-center/category-summary.tsx
git commit -m "feat(targets): CategorySummary 补图片分享导出+修Excel表头空格"
```

---

## Task 7: 导入 diff 预览 modal 组件

**Files:**
- Create: `web/components/report-center/import-diff-modal.tsx`

**Interfaces:**
- Consumes: Task 2 的 `DiffEntry`。
- Produces: `<ImportDiffModal diffs onClose onConfirm />`，供 Task 8 接入。

- [ ] **Step 1: 写组件**

创建 `web/components/report-center/import-diff-modal.tsx`：
```tsx
"use client";

import { Download } from "lucide-react";
import type { DiffEntry } from "@/lib/report-center/import-diff";

const METRIC_NAME: Record<string, string> = { sale: '销售', delivery: '配送' };

export function ImportDiffModal({
  diffs,
  onConfirm,
  onClose,
}: {
  diffs: DiffEntry[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const changedStores = new Set(diffs.map(d => d.branch_num)).size;
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-w-[92vw] max-h-[80vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-bold text-lg">导入预览</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-sm">取消</button>
        </div>
        <div className="text-sm text-slate-500 mb-3 tabular-nums">
          变更 <b className="text-slate-700">{changedStores}</b> 家门店 / <b className="text-slate-700">{diffs.length}</b> 个值
        </div>
        {diffs.length === 0 ? (
          <div className="text-center text-slate-400 py-8 text-sm">无变更</div>
        ) : (
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead><tr className="bg-slate-50">
              {['门店', '指标', '原值', '新值', '差额'].map(h => <th key={h} className="border border-slate-200 p-2 text-left font-normal">{h}</th>)}
            </tr></thead>
            <tbody>
              {diffs.map((d, i) => (
                <tr key={i}>
                  <td className="border border-slate-200 p-2">{d.branch_name || d.branch_num} <span className="text-xs text-slate-400">{d.branch_num}</span></td>
                  <td className="border border-slate-200 p-2">{METRIC_NAME[d.metric] || d.metric}</td>
                  <td className="border border-slate-200 p-2 text-right">{d.oldValue.toLocaleString()}</td>
                  <td className="border border-slate-200 p-2 text-right">{d.newValue.toLocaleString()}</td>
                  <td className={`border border-slate-200 p-2 text-right ${d.diff > 0 ? 'text-green-600' : 'text-red-600'}`}>{d.diff > 0 ? '+' : ''}{d.diff.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end gap-2 pt-3 border-t mt-3">
          <button onClick={onClose} className="border border-slate-300 px-4 py-1 text-sm rounded-md hover:bg-slate-50">取消</button>
          <button onClick={onConfirm} disabled={diffs.length === 0} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Download size={14} /> 确认覆盖
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: build 验证**

Run: `cd web && npm run build`
Expected: 通过（组件未接入，但不影响编译）

- [ ] **Step 3: Commit**

```bash
git add web/components/report-center/import-diff-modal.tsx
git commit -m "feat(targets): 新建 Excel 导入 diff 预览 modal 组件"
```

---

## Task 8: 录入分解页（slate + 卡片 + 配销比列 + chip + 接入 diff modal）

**Files:**
- Modify: `web/app/admin/targets/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 1 `targetRatio/formatRatio`、Task 2 `diffImport/DiffEntry/TargetMetricRow`、Task 7 `ImportDiffModal`。

- [ ] **Step 1: import 补充**

文件顶部 import 加：
```tsx
import { targetRatio, formatRatio } from '@/lib/report-center/ratio';
import { diffImport, type TargetMetricRow } from '@/lib/report-center/import-diff';
import { ImportDiffModal } from '@/components/report-center/import-diff-modal';
```

- [ ] **Step 2: 配色 gray → slate（全文替换）**

对 `app/admin/targets/[id]/page.tsx` 做以下字符串替换（replace_all 各自）：
- `bg-gray-100` → `bg-slate-50`
- `bg-gray-50` → `bg-slate-50/60`
- `text-gray-400` → `text-slate-400`
- `text-gray-500` → `text-slate-500`
- `text-gray-600` → `text-slate-600`
- `text-gray-400 hover:text-gray-600` → `text-slate-400 hover:text-slate-600`
- `border-gray-300` → `border-slate-300`
- 表格单元格 `className="border p-2 ..."` 的 `border`（单独）→ `border border-slate-200`

⚠️ sticky 工具条原已是 `bg-white/95`，保持不动。

- [ ] **Step 3: 卡片容器**

总部品类表（约 line 172 `<table className="text-sm border-collapse tabular-nums mb-6 w-full max-w-2xl">`）外层包 div：
```tsx
<div className="rounded-lg border border-slate-200 bg-white p-4 mb-6 max-w-2xl">
  <h2 ...>总部板块·品类分解 ...</h2>
  <table ...>...</table>
</div>
```
门店三级表（约 line 195 `<div className="overflow-auto max-h-[70vh] border border-slate-200 rounded-md">`）外层再包一层卡片 `rounded-lg border border-slate-200 bg-white p-4`（含标题 h2）。

- [ ] **Step 4: 门店表加配销比列**

表头（约 line 198-204 `<tr>`）在 `门店配送` th 后加：
```tsx
<th className="border border-slate-200 p-2 text-right w-28">配销比</th>
```

门店行（约 line 263 `{STORE_METRICS.map(m => <td>...</td>)}`）后加：
```tsx
<td className="border border-slate-200 p-2 text-right tabular-nums text-slate-500 text-xs">
  {formatRatio(targetRatio(Number(store.metrics?.delivery) || 0, Number(store.metrics?.sale) || 0))}
</td>
```
战区行（约 line 227-230）、区域行（约 line 250-253）同理，在对应 `{STORE_METRICS.map(...)}` 后加 td，值用 `formatRatio(targetRatio(wzRegionSum(wz.war_zone,'delivery'), wzRegionSum(wz.war_zone,'sale')))` / 区域版 `r2StoreSum(...)`。

- [ ] **Step 5: 顶部 SumChip 加配销比**

约 line 149-153 工具条，在 SumChip「总仓出库毛利」后加：
```tsx
<SumChip label="配销比" sum={storeSum('delivery')} total={storeSum('sale')} />
```
⚠️ SumChip 现逻辑是 `diff = sum - total`，配销比语义不同（是比值）。给 SumChip 加一个 `ratio?: boolean` prop：当 ratio 时显示 `formatRatio(total ? sum/total : null)` 而非差额。改造 SumChip：
```tsx
function SumChip({ label, sum, total, ratio }: { label: string; sum: number; total: number; ratio?: boolean }) {
  if (ratio) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600 tabular-nums">
        {label} <b>{formatRatio(total ? sum / total : null)}</b>
      </span>
    );
  }
  // ... 原 diff 逻辑保持
}
```

- [ ] **Step 6: 接入 diff 预览（替换 handleImport）**

原 `handleImport`（约 line 125-138）改为：解析后不直接 setBranchRows，而是算 diff 存 state，弹 modal。

组件 state 加：
```tsx
const [pendingDiff, setPendingDiff] = useState<DiffEntry[] | null>(null);
const [pendingRows, setPendingRows] = useState<TargetMetricRow[] | null>(null);
```

新 handleImport：
```tsx
const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const f = e.target.files?.[0]; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  try {
    const r = await fetch('/api/admin/targets/template', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.rows) {
      const incoming: TargetMetricRow[] = j.rows.map((x: any) => ({ branch_num: x.branch_num, branch_name: x.branch_name, metrics: x.metrics }));
      const cur: TargetMetricRow[] = branchRows.map(b => ({ branch_num: b.branch_num, branch_name: b.branch_name, metrics: b.metrics }));
      const diffs = diffImport(cur, incoming);
      setPendingRows(incoming);
      setPendingDiff(diffs);
      if (diffs.length === 0) toast.info('导入文件无变更');
    } else { toast.error('解析失败：' + (j.error || JSON.stringify(j))); }
  } catch (err) { toast.error('解析失败：' + String(err)); }
  e.target.value = '';
};
const confirmImport = () => {
  if (!pendingRows) return;
  const byBn = Object.fromEntries(pendingRows.map(x => [x.branch_num, x.metrics]));
  setBranchRows(rs => rs.map(rw => byBn[rw.branch_num] ? { ...rw, metrics: { ...rw.metrics, ...byBn[rw.branch_num] } } : rw));
  // 新增门店（当前没有的）追加
  const existing = new Set(branchRows.map(r => r.branch_num));
  const added = pendingRows.filter(r => !existing.has(r.branch_num)).map(r => ({ branch_num: r.branch_num, branch_name: r.branch_name || '', war_zone: '', region_l2: '', metrics: r.metrics }));
  if (added.length) setBranchRows(rs => [...rs, ...added] as any);
  setPendingDiff(null); setPendingRows(null);
  toast.success(`已应用导入变更，请点「保存全部分解」落库`);
};
```

JSX 末尾（组件 return 前）加 modal：
```tsx
{pendingDiff && (
  <ImportDiffModal diffs={pendingDiff} onClose={() => { setPendingDiff(null); setPendingRows(null); }} onConfirm={confirmImport} />
)}
```

- [ ] **Step 7: build 验证**

Run: `cd web && npm run build`
Expected: 通过

- [ ] **Step 8: Commit**

```bash
git add web/app/admin/targets/\[id\]/page.tsx
git commit -m "feat(targets): 分解页 slate 化+配销比列+导入 diff 预览"
```

---

## Task 9: 录入列表页 + 新建 modal（slate + 卡片 + 徽章 + 术语 + 配销比）

**Files:**
- Modify: `web/app/admin/targets/page.tsx`

- [ ] **Step 1: 术语 + 文案 bug**

- `STORE_METRICS`（line 12-15）：`{ code: 'sale', name: '门店零售' }` → `{ code: 'sale', name: '门店销售' }`；delivery `门店配送` 保持
- line 39 描述文案 `门店零售/门店配送` → `门店销售/门店配送`
- line 43 表头数组 `'门店零售'` → `'门店销售'`
- line 84 `请填满总部板块 4 个品类目标值` → `请填满总部板块 3 个品类目标值`
- line 66 注释、line 135 文案中的 `门店零售` → `门店销售`

- [ ] **Step 2: gray → slate（全文替换）**

同 Task 8 Step 2 的替换表，应用于 `app/admin/targets/page.tsx`：
`bg-gray-100→bg-slate-50`、`bg-gray-50→bg-slate-50/60`、`text-gray-400/500/600→text-slate-*`、`bg-black/40→bg-slate-900/40`、`border-gray-300→border-slate-300`、单元格 `border`→`border border-slate-200`。

- [ ] **Step 3: 状态徽章中文化**

列表「状态」列（约 line 55 `<td className="...">{t.status}</td>`）改为中文徽章：
```tsx
<td className="border border-slate-200 p-2">
  <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${t.status === 'active' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
    {t.status === 'active' ? '进行中' : '已结束'}
  </span>
</td>
```

- [ ] **Step 4: 列表 + 新建 modal 表格包卡片容器**

- 列表 table（约 line 41）外层包 `<div className="rounded-lg border border-slate-200 bg-white p-4">`
- TargetForm 内总部板块 table（约 line 116）、门店板块 grid（约 line 136）各包卡片容器

- [ ] **Step 5: 新建 modal 加配销比只读**

import 加 `import { targetRatio, formatRatio } from '@/lib/report-center/ratio';`

门店板块（约 line 136-140 `{STORE_METRICS.map(...)}`）后加只读配销比显示：
```tsx
<div className="col-span-2 mt-1 text-xs text-slate-500 tabular-nums">
  配销比（自动）：{formatRatio(targetRatio(Number(storeVals.delivery) || 0, Number(storeVals.sale) || 0))}
</div>
```

- [ ] **Step 6: build + commit**

Run: `cd web && npm run build`（Expected: 通过）
```bash
git add web/app/admin/targets/page.tsx
git commit -m "style(targets): 录入列表 slate 化+中文徽章+术语+配销比只读+修文案bug"
```

---

## Task 10: 前台 sidebar 改造 + 删 settings 页 + 删死代码

**Files:**
- Modify: `web/components/layout/sidebar.tsx`
- Delete: `web/app/settings/page.tsx`
- Delete: `web/lib/report-center/achievement.ts`
- Delete: `web/components/charts/gauge-chart.tsx`

- [ ] **Step 1: 删前再确认零引用**

Run:
```bash
cd web && grep -rn "report-center/achievement\|/achievement\"" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v "__tests__"
grep -rn "gauge-chart\|GaugeChart" --include="*.ts" --include="*.tsx" . | grep -v node_modules
grep -rn "\"/settings\"\|'/settings'" --include="*.ts" --include="*.tsx" . | grep -v node_modules
```
Expected: achievement/gauge-chart 无引用；`/settings` 仅 sidebar（Step 2 会改）。

- [ ] **Step 2: 改 sidebar.tsx**

`web/components/layout/sidebar.tsx` 整体改为：
```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const menuItems = [
  { id: "reports", label: "报表中心", icon: <LayoutDashboard size={18} strokeWidth={1.5} /> },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-64 border-r border-slate-200 bg-slate-50 min-h-[calc(100vh-64px)]">
      <nav className="p-4 space-y-2">
        {menuItems.map((item) => {
          const active = item.href ? (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) : false;
          return (
            <Link
              key={item.id}
              href="/"
              className={cn(
                "flex w-full items-center justify-start rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-slate-200 text-slate-900" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
              )}
            >
              <span className="mr-2 text-slate-500">{item.icon as ReactNode}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```
（删 settings 菜单项；emoji 📊 → lucide LayoutDashboard；gray → slate）

- [ ] **Step 3: 删 3 个文件**

```bash
cd web && rm app/settings/page.tsx lib/report-center/achievement.ts components/charts/gauge-chart.tsx
rmdir app/settings 2>/dev/null; true
```

- [ ] **Step 4: build 验证**

Run: `cd web && npm run build`
Expected: 通过（无残留 import 报错）

- [ ] **Step 5: Commit**

```bash
git add -A web/components/layout/sidebar.tsx web/app/settings web/lib/report-center/achievement.ts web/components/charts/gauge-chart.tsx
git commit -m "chore(targets): 前台sidebar去设置项+emoji换lucide; 删settings页/死代码"
```

---

## 全部完成后的验收

- [ ] 跑全部单测：`cd web && npm test`（ratio + import-diff 全绿）
- [ ] build：`cd web && npm run build`（全绿）
- [ ] grep 核对术语残留：`cd web && grep -rn "月出库\|门店零售" app components`（达成端应无残留）
- [ ] grep 核对 emoji：`grep -rn "📊\|⚙️" web/components web/app`（无残留）
- [ ] 告知用户验收 + 是否 push（`git push origin main` 触发 GHA）

---

## Self-Review

**1. Spec 覆盖**：
- §2 术语 → Task 3（前端 label + DB 迁移 077 + 架构）+ Task 5（region-drill 文案）+ Task 8/9（admin 文案）✅
- §3 设置页清理 → Task 10 ✅
- §4 录入端靠拢 → Task 8（分解页）+ Task 9（列表+modal）✅
- §4.5 配销比录入端 → Task 1（函数）+ Task 8（列+chip）+ Task 9（modal）✅
- §5 Excel diff 预览 → Task 2（函数）+ Task 7（modal）+ Task 8（接入）✅
- §6.1 KPI 口径 → Task 4 ✅
- §6.2 focus 死代码 → Task 4 ✅
- §6.3 导出图片分享 → Task 5（Region）+ Task 6（Category）✅
- §6.4 死代码 → Task 10 ✅
- §6.5 配销比达成率 → Task 1（函数）+ Task 5（列）✅
- §7 sidebar → Task 10 ✅
- §8 文件清单 14 处 → 全覆盖 ✅

**2. Placeholder 扫描**：Task 5 Step 5 配销比列代码我给了最终简化版（主数字+副小字），无占位。其余无 TBD。✅

**3. 类型一致**：`targetRatio`/`ratioAchievement`/`formatRatio` 在 Task 1 定义，Task 5/8/9 使用，签名一致；`diffImport`/`DiffEntry`/`TargetMetricRow` 在 Task 2 定义，Task 7/8 使用，一致。✅

**4. 注意点**：
- RegionDrillTable 的 `node.data` 字段名（sale_target/sale_actual/delivery_target/delivery_actual）来自 `RegionBreakdownRow`（region-breakdown.ts），已确认存在。
- Task 8 的 SumChip 改造加 `ratio` prop，不影响现有非 ratio 调用（默认 undefined 走原逻辑）。
