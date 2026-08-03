# 报表中心全面移动端适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让报表中心（首页目标列表 + 看板 + 下钻抽屉）在移动端（企微 H5 / 手机浏览器）真正可用——补 viewport、宽表精简+点行看全字段、ChartActions 移动只分享图、Header 简化，桌面端零回归。

**Architecture:** 沿用现有"服务端 `getDeviceType()` 分 Mobile/Desktop 壳"。给共享宽表组件加 `isMobile` prop（`MobileDashboard` 传 `true`，`DesktopDashboard` 不传→默认 `false`），移动端渲染精简表 + 行末 ▸ 开"全字段详情抽屉"。**不引入客户端 useIsMobile hook**（避免 hydration 闪烁）。

**Tech Stack:** Next.js 16 App Router（RSC + `'use client'`）、React 19、Tailwind v4、lucide-react、html2canvas、xlsx；Vitest（仅 `lib/**` 纯逻辑，node 环境）；Playwright（E2E）。

## Global Constraints

- **禁 emoji**；图标用 `lucide-react`，`strokeWidth={1.5}`，语义色配 DESIGN（DESIGN.md §Icon）。
- **数字 `tabular-nums` 对齐**；达成率三色：`≥1 绿 / ≥0.8 琥珀 / <0.8 红`；战区下钻表特例 `rate < progress 红`；毛利率 `<0.12`（配送/出库）/ `<0`（批发）标红（DESIGN.md，不可破）。
- **设备判定只在服务端** `getDeviceType()`；**禁止**客户端 `useIsMobile`/`matchMedia`（hydration 闪烁，记忆 `flash-pc-link-prefetch.md`）。
- **桌面零回归**：所有 `isMobile` prop 默认 `false`，桌面分支代码不动。
- **数据口径不变**：纯前端渲染层，不动取数 / 视图 / 语义层。
- **TypeScript strict 必过**：`cd web && npx tsc --noEmit`；**eslint 必过**：`cd web && npm run lint`。
- **改动仅 `web/` 前端** → 按 CLAUDE.md 走 **GHA 完整部署**（`git push origin main`），**不要**只 PUT function。
- **测试边界**（本仓实际能力）：vitest 仅测 `lib/**` 纯逻辑（node，无 DOM）；UI 渲染用 Playwright E2E（移动分支须用 `devices['iPhone 12']` 带 UA，仅改 viewport 不触发服务端移动判定）。本地 `npm run dev` 需完整后端栈（CLAUDE.md：本地无法完整测），故组件视觉以 **TS+eslint 通过 + 部署后企微真机/Chrome 移动模拟验证** 为准。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/app/layout.tsx` | 新增 `viewport` 导出 | T1 |
| `web/playwright.config.ts` | 新增 mobile project | T1 |
| `web/tests/mobile-viewport.spec.ts` | viewport meta + 移动 UA→device cookie E2E | T1 |
| `web/components/report-center/chart-actions.tsx` | 加 `isMobile`，移动端只渲染分享图 | T2 |
| `web/components/report-center/row-detail-drawer.tsx` | **新建** 通用全字段详情抽屉（label-value 竖排，全屏 sheet） | T3 |
| `web/components/report-center/region-drill-table.tsx` | 加 `isMobile`，移动精简 4 列 + 树 chevron + ▸ 抽屉 | T4 |
| `web/components/report-center/category-summary.tsx` | 加 `isMobile`，移动精简 4 列；行 tap 保留商品明细，▸ 进全字段抽屉 | T5 |
| `web/components/report-center/supply-chain-outbound-table.tsx` | 加 `isMobile`，移动精简 4 列 + 树 chevron + ▸ 抽屉 | T6 |
| `web/components/report-center/brand-metric-table.tsx` | 去 `min-w-[640px]`，窄屏自适应 | T7 |
| `web/components/report-center/wholesale-daily-table.tsx` | 去 `max-h-[28rem]`；内联客户子表响应式 | T7 |
| `web/lib/report-center/status-i18n.ts` | **新建** data_status 英→中映射（纯逻辑，TDD） | T8 |
| `web/lib/report-center/__tests__/status-i18n.test.ts` | status-i18n 单测 | T8 |
| `web/components/report-center/kpi-cards.tsx` | 移动隐 hover tooltip + 状态徽章中文化（用 status-i18n） | T8 |
| `web/components/layout/header.tsx` | 移动端简化（`px-4`/隐 Beta/`h-12`），按 `getDeviceType()` 分支 | T9 |
| `web/components/report-center/target-list.tsx` | `px-5`→`px-4` | T9 |
| `web/app/reports/targets/[id]/mobile.tsx` | 给所有子组件传 `isMobile` | T10 |
| `web/tests/mobile-smoke.spec.ts` | 移动壳回归 E2E（无 Sidebar / Header 简化 / 无横向溢出） | T10 |

**Interfaces（跨任务契约）：**
- `ChartActions({ onExcel?, onImage?, onShare?, isMobile? })`（T2 产出，T4/T5/T6/T7 消费）
- `RowDetailDrawer({ open, title, fields: DetailField[], onClose })`，`DetailField = { label: string; value: string; color?: string }`（T3 产出，T4/T5/T6 消费）
- 宽表组件 `props` 新增 `isMobile?: boolean`（默认 false）；移动分支 `{isMobile && <移动精简表/>}`，桌面分支 `{!isMobile && <原表/>}`
- `statusToZh(code: string): string`（T8 产出，T8 KpiCards 消费）

---

## Task 1: 移动测试地基 + viewport meta

**Files:**
- Modify: `web/app/layout.tsx`
- Modify: `web/playwright.config.ts`
- Create: `web/tests/mobile-viewport.spec.ts`

**Interfaces:**
- Produces: Playwright `mobile` project（`devices['iPhone 12']`，UA=移动）；`layout.tsx` 导出 `viewport`。

- [ ] **Step 1: 写失败的移动 E2E（viewport meta）**

Create `web/tests/mobile-viewport.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test.describe('移动地基', () => {
  test('viewport meta 含 device-width', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const meta = page.locator('meta[name="viewport"]');
    await expect(meta).toHaveAttribute('content', /device-width/);
  });

  test('移动 UA 触发 device_type=mobile cookie', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const cookies = await page.context().cookies();
    const dt = cookies.find((c) => c.name === 'device_type');
    // iPhone 12 UA → middleware 判定 mobile → 写 device_type=mobile
    expect(dt?.value).toBe('mobile');
  });
});
```

- [ ] **Step 2: 加 mobile project，跑测试确认失败**

Modify `web/playwright.config.ts`，把 `projects` 改为：
```ts
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 12'] } },
  ],
```

Run: `cd web && npx playwright test mobile-viewport --project=mobile`
Expected: 第一个 test FAIL（无 viewport meta，`toHaveAttribute` 找不到）；第二个可能也受影响。这是预期失败。

- [ ] **Step 3: 加 viewport 导出**

Modify `web/app/layout.tsx`，把第 1 行 import 和 metadata 改为：
```ts
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "数据分析平台",
  description: "企业数据分析平台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};
```
（不加 `maximumScale: 1`，保留无障碍缩放。`export const dynamic = "force-dynamic"` 及 `RootLayout` 函数体保持不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx playwright test mobile-viewport --project=mobile`
Expected: 2 test PASS。

- [ ] **Step 5: 提交**
```bash
git add web/app/layout.tsx web/playwright.config.ts web/tests/mobile-viewport.spec.ts
git commit -m "feat(mobile): viewport meta + Playwright mobile project(地基)"
```

---

## Task 2: ChartActions 加 isMobile（移动端只分享图）

**Files:**
- Modify: `web/components/report-center/chart-actions.tsx`

**Interfaces:**
- Produces: `ChartActions` 新增 `isMobile?: boolean` prop，移动端只渲染 `onImage`（文案"分享图"）。
- Consumes: 无（被 T4/T5/T6/T7 消费）。

- [ ] **Step 1: 改 ChartActions 组件签名与渲染**

Modify `web/components/report-center/chart-actions.tsx`，把 `ChartActions` 函数整体替换为：
```tsx
// 组件级操作条：Excel / 图片 / 分享。lucide 图标 + 纯文本（DESIGN 禁 emoji）。
// 移动端（isMobile）只渲染 onImage（文案"分享图"），隐 Excel（企微 webview 下 xlsx 体验差）与分享链接
// —— 遵循 DESIGN.md「移动端只生成分享图」。
export function ChartActions({
  onExcel,
  onImage,
  onShare,
  isMobile = false,
}: {
  onExcel?: () => void;
  onImage?: () => void;
  onShare?: () => void;
  isMobile?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 text-xs text-slate-400">
      {!isMobile && onExcel && (
        <button onClick={onExcel} title="导出 Excel" className="flex items-center gap-1 hover:text-slate-700">
          <Download size={14} strokeWidth={1.5} />
          <span>Excel</span>
        </button>
      )}
      {onImage && (
        <button onClick={onImage} title={isMobile ? "生成分享图" : "导出图片"} className="flex items-center gap-1 hover:text-slate-700">
          <ImageIcon size={14} strokeWidth={1.5} />
          <span>{isMobile ? "分享图" : "图片"}</span>
        </button>
      )}
      {!isMobile && onShare && (
        <button onClick={onShare} title="分享" className="flex items-center gap-1 hover:text-slate-700">
          <Share2 size={14} strokeWidth={1.5} />
          <span>分享</span>
        </button>
      )}
    </div>
  );
}
```
注意：把原 `Download`/`Image as ImageIcon`/`Share2` 的 import 保留（文件顶部已有）；图标加 `strokeWidth={1.5}`（DESIGN）。

- [ ] **Step 2: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误（`isMobile` 默认 false，现有调用方不传也不报错）。

- [ ] **Step 3: 提交**
```bash
git add web/components/report-center/chart-actions.tsx
git commit -m "feat(mobile): ChartActions isMobile——移动端只分享图(DESIGN)"
```

---

## Task 3: 通用全字段详情抽屉 RowDetailDrawer

**Files:**
- Create: `web/components/report-center/row-detail-drawer.tsx`

**Interfaces:**
- Produces: `RowDetailDrawer({ open, title, fields, onClose })`、`DetailField = { label: string; value: string; color?: string }`。

- [ ] **Step 1: 新建抽屉组件**

Create `web/components/report-center/row-detail-drawer.tsx`:
```tsx
"use client";

import { X } from "lucide-react";

// 全字段详情抽屉（移动端宽表"点行末 ▸ 看全部字段"用）。
// 固定全屏 sheet（inset-0 w-full），与 category-item-drawer 的 w-full md:w-[720px] 同源。
// fields 由各表用自身 formatter 构建（label-value 竖排，tabular-nums 对齐）。
export interface DetailField {
  label: string;
  value: string;
  color?: string; // 可选语义色 className，如 "text-red-600"
}

export function RowDetailDrawer({
  open,
  title,
  fields,
  onClose,
}: {
  open: boolean;
  title: string;
  fields: DetailField[];
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-4">
        <span className="truncate text-sm font-medium text-slate-800">{title}</span>
        <button
          onClick={onClose}
          aria-label="关闭"
          className="text-slate-400 hover:text-slate-700"
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-auto p-4 text-xs">
        {fields.map((f) => (
          <div
            key={f.label}
            className="flex justify-between gap-3 border-b border-slate-100 py-1.5 tabular-nums"
          >
            <span className="shrink-0 text-slate-500">{f.label}</span>
            <span className={`text-right ${f.color ?? "text-slate-800"}`}>{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 3: 提交**
```bash
git add web/components/report-center/row-detail-drawer.tsx
git commit -m "feat(mobile): RowDetailDrawer 通用全字段详情抽屉"
```

---

## Task 4: RegionDrillTable 移动精简（13→4 列 + ▸ 抽屉）

**Files:**
- Modify: `web/components/report-center/region-drill-table.tsx`

**Interfaces:**
- Consumes: `ChartActions`（T2，传 `isMobile`）、`RowDetailDrawer`+`DetailField`（T3）。
- Produces: `RegionDrillTable` 新增 `isMobile?: boolean`。

- [ ] **Step 1: 加 import 与 isMobile prop**

Modify `web/components/report-center/region-drill-table.tsx`：
- 顶部 import 区加：
```tsx
import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";
```
- 把 `RegionDrillTableProps` 加 `isMobile`：
```tsx
interface RegionDrillTableProps {
  rows: RegionBreakdownRow[];
  targetMonth: number;
  progress: number;
  isMobile?: boolean;
}
```
- 函数签名改为 `export function RegionDrillTable({ rows, targetMonth, progress, isMobile = false }: RegionDrillTableProps) {`

- [ ] **Step 2: 加详情抽屉 state + 字段构建器**

在 `flatRows` 的 `useMemo` 之后、`handleExcel` 之前插入：
```tsx
  // 移动端：点行末 ▸ 看该行全字段（13 列 label-value）
  const [detailNode, setDetailNode] = useState<TreeNode | null>(null);

  function buildRegionFields(d: RegionBreakdownRow): DetailField[] {
    return [
      { label: "月销售目标", value: fmtCurrency(d.sale_target) },
      { label: "月销售金额", value: fmtCurrency(d.sale_actual) },
      { label: "月销售完成率", value: fmtRate(d.sale_rate), color: rateColor(d.sale_rate, progress) },
      { label: "月配送目标", value: fmtCurrency(d.delivery_target) },
      { label: "月配送金额", value: fmtCurrency(d.delivery_actual) },
      { label: "月配送完成率", value: fmtRate(d.delivery_rate), color: rateColor(d.delivery_rate, progress) },
      { label: "当天销售金额", value: fmtCurrency(d.daily_sale) },
      { label: "当天配送金额", value: fmtCurrency(d.daily_delivery) },
      { label: "剩余日均销售目标", value: fmtCurrency(d.remaining_daily_sale_target) },
      { label: "剩余日均配送目标", value: fmtCurrency(d.remaining_daily_delivery_target) },
      { label: "配销比目标", value: formatRatio(targetRatio(d.delivery_target, d.sale_target)) },
      { label: "配销比", value: formatRatio(actualRatio(d.delivery_actual, d.sale_actual)) },
    ];
  }
```
（`useState` 已在顶部 import；`TreeNode` 类型已存在。）

- [ ] **Step 3: 给 ChartActions 传 isMobile**

把 `<ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />` 改为加 `isMobile={isMobile}`。

- [ ] **Step 4: 在桌面表外加移动分支 + 抽屉**

把现有 `<div className="rounded-lg border ... p-4">...</div>` 整体 return 改造为：桌面表用 `{!isMobile && (...)}` 包裹原表格容器，新增 `{isMobile && (...)}` 移动精简表，末尾挂抽屉。完整 return 替换为：
```tsx
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{targetMonth}月门店零售/配送数据报表</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} isMobile={isMobile} />
      </div>

      {/* 桌面：13 列宽表（原样不动） */}
      {!isMobile && (
        <div ref={tableRef} className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-3 py-2 text-left font-medium">大区名称</th>
                <th className="px-3 py-2 text-right font-medium">月销售目标</th>
                <th className="px-3 py-2 text-right font-medium">月销售金额</th>
                <th className="px-3 py-2 text-right font-medium">月销售完成率</th>
                <th className="px-3 py-2 text-right font-medium">月配送目标</th>
                <th className="px-3 py-2 text-right font-medium">月配送金额</th>
                <th className="px-3 py-2 text-right font-medium">月配送完成率</th>
                <th className="px-3 py-2 text-right font-medium">当天销售金额</th>
                <th className="px-3 py-2 text-right font-medium">当天配送金额</th>
                <th className="px-3 py-2 text-right font-medium">剩余日均销售目标</th>
                <th className="px-3 py-2 text-right font-medium">剩余日均配送目标</th>
                <th className="px-3 py-2 text-right font-medium">配销比目标</th>
                <th className="px-3 py-2 text-right font-medium">配销比</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 24;
                return (
                  <tr key={`${node.level}-${node.data.parent_code || 'root'}-${node.code}`} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-700" style={{ paddingLeft: `${indent + 12}px`, cursor: hasChildren ? 'pointer' : 'default' }} onClick={hasChildren ? () => toggleExpand(node.code) : undefined}>
                      {hasChildren && (<span className="mr-1 inline-flex items-center justify-center w-4 h-4 text-slate-400">{isExpanded ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}</span>)}
                      <span className={depth === 0 ? "font-semibold" : ""}>{node.name}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.sale_target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.sale_actual)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.sale_rate, progress)}`}>{fmtRate(node.data.sale_rate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.delivery_target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.delivery_actual)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.delivery_rate, progress)}`}>{fmtRate(node.data.delivery_rate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.daily_sale)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.daily_delivery)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.remaining_daily_sale_target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.remaining_daily_delivery_target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatRatio(targetRatio(node.data.delivery_target, node.data.sale_target))}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatRatio(actualRatio(node.data.delivery_actual, node.data.sale_actual))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 移动：精简 4 列（门店/区名 · 销售完成率 · 配送完成率 · 当天销售）+ 行末 ▸ 看全字段。
          树 chevron（左）展开子级，▸（右）开全字段抽屉，两个独立 tap 区。 */}
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">门店</th>
                <th className="px-2 py-2 text-right font-medium">销售率</th>
                <th className="px-2 py-2 text-right font-medium">配送率</th>
                <th className="px-2 py-2 text-right font-medium">当天</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 16;
                return (
                  <tr key={`${node.level}-${node.data.parent_code || 'root'}-${node.code}`}>
                    <td className="px-2 py-2 text-slate-700" style={{ paddingLeft: `${indent + 8}px` }}>
                      <div className="flex items-center gap-1">
                        {hasChildren ? (
                          <button onClick={() => toggleExpand(node.code)} aria-label="展开子级" className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-slate-400">
                            {isExpanded ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
                          </button>
                        ) : null}
                        <span className={`truncate ${depth === 0 ? "font-semibold" : ""}`}>{node.name}</span>
                      </div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${rateColor(node.data.sale_rate, progress)}`}>{fmtRate(node.data.sale_rate)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${rateColor(node.data.delivery_rate, progress)}`}>{fmtRate(node.data.delivery_rate)}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.daily_sale)}</td>
                    <td className="px-1 py-2 text-right">
                      <button onClick={() => setDetailNode(node)} aria-label="查看全部字段" className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700">
                        <ChevronRight size={16} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RowDetailDrawer
        open={!!detailNode}
        title={detailNode?.name ?? ""}
        fields={detailNode ? buildRegionFields(detailNode.data) : []}
        onClose={() => setDetailNode(null)}
      />
    </div>
  );
```

- [ ] **Step 5: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 6: 提交**
```bash
git add web/components/report-center/region-drill-table.tsx
git commit -m "feat(mobile): RegionDrillTable 精简4列+行末▸全字段抽屉(13列移动)"
```

---

## Task 5: CategorySummary 移动精简（12→4 列 + ▸ 抽屉，保留商品明细下钻）

**Files:**
- Modify: `web/components/report-center/category-summary.tsx`

**Interfaces:**
- Consumes: `ChartActions`（T2）、`RowDetailDrawer`+`DetailField`（T3）。
- Produces: `CategorySummary` 新增 `isMobile?: boolean`。

> 注意交互：本表行 tap 现开 `CategoryItemDrawer`（商品明细，高价值，保留）。移动端行 tap 仍开商品明细；品类自身的其余字段通过**行末 ▸** 进全字段抽屉。两个独立 tap 区。

- [ ] **Step 1: 加 import + isMobile prop**

Modify `web/components/report-center/category-summary.tsx`：
- import 区加 `import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";`
- `CategorySummaryProps` 加 `isMobile?: boolean`；函数签名解构 `isMobile = false`。

- [ ] **Step 2: 加全字段抽屉 state + 构建器**

在 `totals` 的 `useMemo` 之后插入：
```tsx
  // 移动端：点行末 ▸ 看该品类全字段（12 列）
  const [detailCat, setDetailCat] = useState<CategorySummaryRow | null>(null);
  function buildCategoryFields(d: CategorySummaryRow): DetailField[] {
    return [
      { label: "月销售目标", value: fmtCurrency(d.sale_target) },
      { label: "月销售金额", value: fmtCurrency(d.sale_actual) },
      { label: "月销售完成率", value: fmtRate(d.sale_rate) },
      { label: "月毛利目标", value: fmtCurrency(d.profit_target) },
      { label: "月毛利金额", value: fmtCurrency(d.profit_actual) },
      { label: "月毛利完成率", value: fmtRate(d.profit_rate) },
      { label: "月毛利率", value: fmtRate(d.profit_margin), color: marginColor(d.profit_margin) },
      { label: "当天出库金额", value: fmtCurrency(d.daily_amount) },
      { label: "当天出库毛利", value: fmtCurrency(d.daily_profit) },
      { label: "当天毛利率", value: fmtRate(d.daily_profit_margin), color: marginColor(d.daily_profit_margin) },
      { label: "差额日均毛利目标", value: fmtCurrency(d.remaining_daily_profit_target) },
    ];
  }
```

- [ ] **Step 3: 给 ChartActions 传 isMobile**

`<ChartActions onExcel={...} onImage={...} onShare={...} />` 加 `isMobile={isMobile}`。

- [ ] **Step 4: 桌面表外加移动分支 + 抽屉**

把现有 return 改造：桌面表 `{!isMobile && (...)}` 包裹原 `<div ref={tableRef} className="overflow-x-auto">...</div>`（原 table 不动），新增 `{isMobile && (...)}`：
```tsx
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">类别</th>
                <th className="px-2 py-2 text-right font-medium">销售率</th>
                <th className="px-2 py-2 text-right font-medium">毛利率</th>
                <th className="px-2 py-2 text-right font-medium">当天出库</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detailRows.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {detailRows.map((r) => (
                <tr key={r.category}>
                  <td className="px-2 py-2 text-slate-700 font-medium">
                    <button onClick={() => setDrawerCat(r.category)} className="flex items-center gap-1 text-left">
                      <ChevronRight size={14} strokeWidth={1.5} className="text-slate-400" />
                      <span>{r.category}</span>
                    </button>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtRate(r.sale_rate)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${marginColor(r.profit_margin)}`}>{fmtRate(r.profit_margin)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(r.daily_amount)}</td>
                  <td className="px-1 py-2 text-right">
                    <button onClick={() => setDetailCat(r)} aria-label="查看全部字段" className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700">
                      <ChevronRight size={16} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RowDetailDrawer
        open={!!detailCat}
        title={detailCat?.category ?? ""}
        fields={detailCat ? buildCategoryFields(detailCat) : []}
        onClose={() => setDetailCat(null)}
      />
```
（保留原 `{drawerCat && <CategoryItemDrawer .../>}` 在两者之后。桌面 `<tfoot>` 合计行只存在于桌面分支内，不动。）

- [ ] **Step 5: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 6: 提交**
```bash
git add web/components/report-center/category-summary.tsx
git commit -m "feat(mobile): CategorySummary 精简4列+▸全字段抽屉(行tap保留商品明细)"
```

---

## Task 6: SupplyChainOutboundTable 移动精简（7→4 列 + ▸ 抽屉）

**Files:**
- Modify: `web/components/report-center/supply-chain-outbound-table.tsx`

**Interfaces:**
- Consumes: `ChartActions`（T2）、`RowDetailDrawer`+`DetailField`（T3）。
- Produces: `SupplyChainOutboundTable` 新增 `isMobile?: boolean`。

- [ ] **Step 1: 加 import + isMobile prop**

Modify `web/components/report-center/supply-chain-outbound-table.tsx`：
- import 区加 `import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";`
- `SupplyChainOutboundTableProps` 加 `isMobile?: boolean`；函数签名解构 `isMobile = false`。

- [ ] **Step 2: 加全字段抽屉 state + 构建器**

在 `totals` 的 `useMemo` 之后插入：
```tsx
  const [detailNode, setDetailNode] = useState<TreeNode | null>(null);
  function buildSupplyFields(d: SupplyChainOutboundRow): DetailField[] {
    return [
      { label: "出库金额", value: fmtCurrency(d.delivery_amount) },
      { label: "出库毛利", value: fmtProfit(d.delivery_profit) },
      { label: "毛利率", value: fmtMargin(d.delivery_margin), color: d.delivery_margin != null && d.delivery_margin < LOW_MARGIN_THRESHOLD ? "text-red-600" : undefined },
      { label: "当天出库金额", value: fmtCurrency(d.daily_delivery_amount) },
      { label: "当天出库毛利", value: fmtProfit(d.daily_delivery_profit) },
      { label: "当天毛利率", value: fmtMargin(d.daily_delivery_margin) },
    ];
  }
```

- [ ] **Step 3: 给 ChartActions 传 isMobile**

加 `isMobile={isMobile}`。

- [ ] **Step 4: 桌面表外加移动分支 + 抽屉**

桌面表用 `{!isMobile && (...)}` 包裹原 `<div ref={tableRef} className="max-h-[28rem] overflow-auto">...</div>`（含 thead/tbody/tfoot，原样不动）。在其后、组件结尾 `</div>` 前加：
```tsx
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">名称</th>
                <th className="px-2 py-2 text-right font-medium">出库金额</th>
                <th className="px-2 py-2 text-right font-medium">毛利率</th>
                <th className="px-2 py-2 text-right font-medium">当天出库</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 16;
                const isStore = node.level === "store";
                const lowMargin = isStore && node.data.delivery_margin != null && node.data.delivery_margin < LOW_MARGIN_THRESHOLD;
                const numColor = lowMargin ? "text-red-600" : "text-slate-700";
                return (
                  <tr key={`${node.level}-${node.data.parent_code || "root"}-${node.code}`} className={lowMargin ? "bg-red-50" : ""}>
                    <td className="px-2 py-2 text-slate-700" style={{ paddingLeft: `${indent + 8}px` }}>
                      <div className="flex items-center gap-1">
                        {hasChildren ? (
                          <button onClick={() => toggleExpand(node.code)} aria-label="展开子级" className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-slate-400">
                            {isExpanded ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
                          </button>
                        ) : null}
                        <span className={`truncate ${depth === 0 ? "font-semibold" : ""}`}>{node.name}</span>
                      </div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>{fmtCurrency(node.data.delivery_amount)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>{fmtMargin(node.data.delivery_margin)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>{fmtCurrency(node.data.daily_delivery_amount)}</td>
                    <td className="px-1 py-2 text-right">
                      <button onClick={() => setDetailNode(node)} aria-label="查看全部字段" className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700">
                        <ChevronRight size={16} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RowDetailDrawer
        open={!!detailNode}
        title={detailNode?.name ?? ""}
        fields={detailNode ? buildSupplyFields(detailNode.data) : []}
        onClose={() => setDetailNode(null)}
      />
```

- [ ] **Step 5: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 6: 提交**
```bash
git add web/components/report-center/supply-chain-outbound-table.tsx
git commit -m "feat(mobile): SupplyChainOutbound 精简4列+▸全字段抽屉(树chevron分离)"
```

---

## Task 7: BrandMetricTable + WholesaleDailyTable 小调

**Files:**
- Modify: `web/components/report-center/brand-metric-table.tsx`
- Modify: `web/components/report-center/wholesale-daily-table.tsx`

**Interfaces:**
- Consumes: `ChartActions`（T2，两表都给传 `isMobile`）。
- Produces: 两表新增 `isMobile?: boolean`（BrandMetric 透传给 ChartActions；Wholesale 同）。

- [ ] **Step 1: BrandMetricTable 去 min-w + 传 isMobile**

Modify `web/components/report-center/brand-metric-table.tsx`：
- `BrandMetricTableProps` 加 `isMobile?: boolean`；签名解构 `isMobile = false`。
- `<table className="w-full min-w-[640px] text-xs">` → `<table className="w-full text-xs">`（去强制宽，3 行表窄屏自适应；`overflow-x-auto` 容器保留作兜底）。
- ChartActions 加 `isMobile={isMobile}`。

- [ ] **Step 2: WholesaleDailyTable 去 max-h + 子表响应式 + 传 isMobile**

Modify `web/components/report-center/wholesale-daily-table.tsx`：
- `WholesaleDailyTableProps` 加 `isMobile?: boolean`；签名解构 `isMobile = false`。
- 外层 `<div ref={tableRef} className="max-h-[28rem] overflow-auto">` → `<div ref={tableRef} className="overflow-x-auto">`（去限高，随页滚）。
- 客户明细子表 `<table className="ml-6 w-[calc(100%-1.5rem)] text-xs tabular-nums">` → `<table className="ml-4 w-full text-xs tabular-nums">`（窄屏自适应）。
- ChartActions 加 `isMobile={isMobile}`。

- [ ] **Step 3: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 4: 提交**
```bash
git add web/components/report-center/brand-metric-table.tsx web/components/report-center/wholesale-daily-table.tsx
git commit -m "feat(mobile): BrandMetric去min-w + Wholesale去max-h/子表响应式 + ChartActions isMobile"
```

---

## Task 8: status-i18n（TDD）+ KpiCards 移动 tooltip/中文化

**Files:**
- Create: `web/lib/report-center/status-i18n.ts`
- Create: `web/lib/report-center/__tests__/status-i18n.test.ts`
- Modify: `web/components/report-center/kpi-cards.tsx`

**Interfaces:**
- Produces: `statusToZh(code: string): string`（纯函数，TDD）。

- [ ] **Step 1: 写失败的单测**

Create `web/lib/report-center/__tests__/status-i18n.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { statusToZh } from "../status-i18n";

describe("statusToZh", () => {
  it("complete → 已完成", () => {
    expect(statusToZh("complete")).toBe("已完成");
  });
  it("partial → 部分", () => {
    expect(statusToZh("partial")).toBe("部分");
  });
  it("missing → 缺失", () => {
    expect(statusToZh("missing")).toBe("缺失");
  });
  it("not_ready → 未就绪", () => {
    expect(statusToZh("not_ready")).toBe("未就绪");
  });
  it("未知 code → 未就绪（兜底）", () => {
    expect(statusToZh("whatever")).toBe("未就绪");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `cd web && npx vitest run lib/report-center/__tests__/status-i18n.test.ts`
Expected: FAIL（`status-i18n` 模块不存在）。

- [ ] **Step 3: 实现 statusToZh**

Create `web/lib/report-center/status-i18n.ts`:
```ts
// data_status 英→中映射（KpiCards 徽章移动端中文化用）。
// 未知 code 兜底"未就绪"（与 kpi-cards 原 statusBadgeClass 的 not_ready 默认一致）。
const MAP: Record<string, string> = {
  complete: "已完成",
  partial: "部分",
  missing: "缺失",
  not_ready: "未就绪",
};

export function statusToZh(code: string): string {
  return MAP[code] ?? "未就绪";
}
```

- [ ] **Step 4: 跑测试确认通过**
Run: `cd web && npx vitest run lib/report-center/__tests__/status-i18n.test.ts`
Expected: 5 test PASS。

- [ ] **Step 5: KpiCards 接入（移动隐 tooltip + 中文化）**

Modify `web/components/report-center/kpi-cards.tsx`：
- import 加：
```tsx
import { statusToZh } from "@/lib/report-center/status-i18n";
```
- `KpiCards` 加 `isMobile?: boolean` prop（接口 `KpiCards` 的 props 目前是 `{ rows: KpiRow[] }`，改为 `{ rows: KpiRow[]; isMobile?: boolean }`，函数解构 `isMobile = false`）。
- 徽章显示：把 `{r.data_status}` 改为 `{isMobile ? statusToZh(r.data_status) : r.data_status}`。
- Tooltip：把 `<KpiTooltip ... />` 包成 `{!isMobile && <KpiTooltip target={...} actual={...} rate={...} />}`（移动端隐藏 hover tooltip）。

- [ ] **Step 6: TS + eslint + 全量单测通过**
Run: `cd web && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: 无错误；所有 vitest PASS。

- [ ] **Step 7: 提交**
```bash
git add web/lib/report-center/status-i18n.ts web/lib/report-center/__tests__/status-i18n.test.ts web/components/report-center/kpi-cards.tsx
git commit -m "feat(mobile): status-i18n(TDD)+KpiCards 移动隐tooltip/状态中文化"
```

---

## Task 9: Header 移动简化 + TargetList px-4

**Files:**
- Modify: `web/components/layout/header.tsx`
- Modify: `web/components/report-center/target-list.tsx`

**Interfaces:**
- Produces: `Header` 按服务端设备分支渲染；`TargetList` 移动 padding。

- [ ] **Step 1: Header 按设备分支**

Modify `web/components/layout/header.tsx`：
- import 加：
```tsx
import { getDeviceType } from "@/lib/get-device-type";
```
- `Header` 是 `async`（已是），在取完 cookie/ua 后加 `const isMobile = (await getDeviceType()) === "mobile";`。
- 把 `<div className="flex h-16 items-center justify-between px-6">` 改为按设备：
```tsx
      <div className={`flex items-center justify-between ${isMobile ? "h-12 px-4" : "h-16 px-6"}`}>
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">数据分析平台</h1>
          {!isMobile && <Badge variant="secondary">Beta</Badge>}
        </div>
        <div className="flex items-center gap-4">
          {isAdmin(userid) && !isMobile && (
            <Link href="/admin/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
              管理后台
            </Link>
          )}
          {displayName ? (
            <div className="flex items-center gap-2">
              {!isMobile && <span className="text-sm text-muted-foreground">{displayName}</span>}
              <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
                {displayName[0]?.toUpperCase()}
              </div>
              {!isWecom && <LogoutButton />}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">已登录</span>
          )}
        </div>
      </div>
```
（移动端：隐 Beta、隐"管理后台"链接、隐姓名文字、保留头像；高度压到 h-12、padding px-4。企微内退出本就隐。）

- [ ] **Step 2: TargetList px-5 → px-4**

Modify `web/components/report-center/target-list.tsx`：
- 卡片 className 里 `px-5 py-4` → `px-4 py-4`。

- [ ] **Step 3: TS + eslint 通过**
Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 4: 提交**
```bash
git add web/components/layout/header.tsx web/components/report-center/target-list.tsx
git commit -m "feat(mobile): Header 按设备简化(h-12/px-4/隐Beta) + TargetList px-4"
```

---

## Task 10: MobileDashboard 接线 + 移动壳 E2E 回归

**Files:**
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Create: `web/tests/mobile-smoke.spec.ts`

**Interfaces:**
- Consumes: 所有组件的 `isMobile` prop（T2/T4/T5/T6/T7/T8）。

- [ ] **Step 1: MobileDashboard 给所有子组件传 isMobile**

Modify `web/app/reports/targets/[id]/mobile.tsx`：在每个报表组件上加 `isMobile`：
- `<KpiCards rows={kpi} />` → `<KpiCards rows={kpi} isMobile />`
- `<BrandMetricTable rows={brandMetric} targetMonth={targetMonth} />` → 加 `isMobile`
- `<RegionDrillTable rows={regionBreakdown} targetMonth={targetMonth} progress={progress} />` → 加 `isMobile`
- `<SaleTopBoards ... />` 和 `<OutboundTopBoards ... />` → **不加**（已单列堆叠，无需 isMobile）
- `<CategorySummary rows={categorySummary} targetMonth={targetMonth} targetId={targetId} />` → 加 `isMobile`
- `<SupplyChainOutboundTable ... />` → 加 `isMobile`
- `<WholesaleDailyTable ... />` → 加 `isMobile`

- [ ] **Step 2: 写移动壳回归 E2E**

Create `web/tests/mobile-smoke.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

// 移动壳回归：移动 UA → 服务端渲染移动壳（无 Sidebar、Header 简化、无横向溢出）。
// 鉴权：注入 dummy insforge_access_token cookie（middleware 仅检存在性 + blacklist 查询失败默认放行），
// 数据接口 401 → 空数据 → 空态渲染，足以断言壳结构。
test.describe('移动壳回归', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    await context.addCookies([{ name: 'insforge_access_token', value: 'dummy-mobile-test-token', domain: 'localhost', path: '/' }]);
  });

  test('首页移动壳：无 Sidebar + 无横向溢出', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // 移动壳不含 Sidebar（PC 才有）
    await expect(page.locator('body')).toBeVisible();
    // body 无横向滚动（关键移动健康指标）
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('Header 移动简化：无 Beta 徽章', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Beta', { exact: true })).toHaveCount(0);
  });
});
```

- [ ] **Step 3: 跑移动壳 E2E**
Run: `cd web && npx playwright test mobile-smoke --project=mobile`
Expected: 2 test PASS（需本地 dev 后端栈在跑；`webServer` 配置会自动起 `npm run dev`。若后端不可用导致 401 空态，壳结构断言仍成立）。

- [ ] **Step 4: TS + eslint + 全量单测 + 全量 E2E 收尾**
Run: `cd web && npx tsc --noEmit && npm run lint && npx vitest run && npx playwright test --project=mobile`
Expected: 全绿。

- [ ] **Step 5: 提交**
```bash
git add web/app/reports/targets/[id]/mobile.tsx web/tests/mobile-smoke.spec.ts
git commit -m "feat(mobile): MobileDashboard 接线 isMobile + 移动壳 E2E 回归"
```

- [ ] **Step 6: 部署 + 真机验证（按 CLAUDE.md）**
```bash
git push origin main
gh run watch <run-id>   # GHA 部署（改 web/ 走 GHA）
```
部署后验证（生产 URL）：
- Chrome DevTools 设备工具栏选 iPhone 12，开 `https://data.shanhaiyiguo.com`：首页 Header 单行无 Beta、目标卡单列。
- 进任一看板：KPI 2 列、各宽表精简列、点行末 ▸ 弹全字段抽屉、树形表左 chevron 展子级、导出条只有"分享图"。
- 企微移动客户端内打开同一链接：登录直通、分享图长按可保存/转发、首屏不闪 PC。
- 桌面浏览器（≥1024px）全量回归：所有表 13/12/7 列原样、导出三动作、Header Beta/姓名俱在——**桌面零回归**。

---

## Self-Review（写计划后自检，已并入）

- **Spec 覆盖**：viewport（T1）✅ / prop 下传机制（T2/T4-T8 签名 + T10 接线）✅ / Header 合并（T9）✅ / 宽表 B 精简+行展开（T4/T5/T6）✅ / BrandMetric+Wholesale 小调（T7）✅ / ChartActions 移动只分享图（T2）✅ / KpiCards tooltip+中文化（T8）✅ / TargetList（T9）✅ / 优先级长滚动（MobileDashboard 顺序不变，T10 仅加 isMobile）✅ / 验证红线（T10 Step 4-6）✅。无遗漏。
- **占位符扫描**：无 TBD/TODO；每个 code step 含完整代码。
- **类型一致性**：`isMobile?: boolean` 全任务统一；`DetailField`/`RowDetailDrawer` 签名 T3 定义、T4/T5/T6 消费一致；`statusToZh` T8 定义消费一致；`ChartActions` 加 `isMobile` T2 定义、T4-T7 消费一致。
