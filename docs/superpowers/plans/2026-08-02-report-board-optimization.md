# 报表看板优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 `/reports/targets/[id]` 目标看板的视觉布局、交互下钻、数据口径三维度，含 2 个确认的真 bug 修复（118 脱敏 + dateUpper 日期上界），DESIGN.md 按实际代码口径更新（三色编码+KPI 卡）。

**Architecture:** Phase 1（T1-T5）安全改动：DESIGN.md 更新 + 前端视觉/交互 polish + 118 手写视图脱敏 patch，无生成器改动、无架构风险。Phase 2（T6）架构变更：修 `tier1.ts:84` dateUpper 逻辑（extra_grain 含 biz_date 时用 latest_day），改生成器=架构变更（先更新 architecture.md 再执行，铁律）。T7/T8 为 follow-up plan（join_override 需 DB 验证、KPI 切生成器较大）。

**Tech Stack:** Next.js 15 + TypeScript + Tailwind + lucide-react / 语义层生成器 (services/semantic-generator, tsx + vitest) / PostgreSQL 15 / xlsx + html2canvas

## 需求确认 + DB 核验修正

三维度审查由 3 个 subagent 并行完成，关键 DB 核验修正了 agent 推理：

| 项 | agent 判定 | 核验后 | 依据 |
|---|---|---|---|
| 118 outbound_profit 无脱敏 | 高 真 bug | ✅ 确认 | 118 line 79 无 CASE can_see_cost；其它 _gen 视图均脱敏 |
| outbound<delivery 悖论 | 高 真 bug | ❌ 推翻 | DB: target22 delivery=19.28M **outbound=21.24M**（outbound>delivery）。口径不一致属 brand-ledger 待改造，降级设计取舍 |
| 下钻视图日期上界 end_date | 高 真 bug | ✅ 确认 | tier1.ts:84 dateUpper 未判 extra_grain biz_date |

**用户决策**：
- 三色编码 + KPI 卡色规 **以实际代码为准，改 DESIGN.md**（不改代码）
- 完整方案全包（Phase 1 + Phase 2 架构变更一次审）
- lucide Chevron 换 ▾/▸（统一图标库，已同意）

## Global Constraints

- **铁律**：视图口径由 view-configs + 生成器产出，禁手写 SQL 视图。118 是历史遗留手写视图（架构 §10.10 双轨期豁免），T4 仅 patch 脱敏不重构；根治待 T8 follow-up（KPI 切生成器）。
- **生成器改动=架构变更**（T6）：先更新 `docs/architecture.md` -> 征得用户同意 -> 再执行代码。铁律第2条。
- **成本脱敏**：利润列包 `CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN <val> ELSE NULL END`。
- **门店键**：`(system_book_code, branch_num)` 复合，禁 branch_num 单独 join/去重/PK。
- **禁品牌字面量**：生成器代码不含 '3120'/'64188'。品牌过滤在 metric_sources.source_filter（数据驱动）。
- **迁移幂等**：migrate.sh 重跑全部迁移，视图用 `DROP VIEW IF EXISTS + CREATE VIEW`（不可 `CREATE OR REPLACE` 改列）；函数返回类型变更须 `DROP FUNCTION`。加视图/RPC 后 restart postgrest。
- **部署**：改前端/迁移/生成器 -> `git push` 走 GHA。改生成器后 `npm run gen-views`（SSH 隧道连 prod）重生成 SQL。
- **DESIGN.md 色规**（以实际为准，T1 更新文档非改代码）：
  - 达成率三色（默认）：绝对值 `≥1 绿 / ≥0.8 琥珀 / <0.8 红`；progress 仅副信息
  - 达成率三色（战区下钻表特例）：`rate<progress -> 红`，其余按绝对值
  - KPI 卡：大数字直接套三色（非 primary 蓝）
  - 毛利率标红（二元）：配送/出库门店行 `<12%`；批发 `<0`

## File Structure

**DESIGN.md（T1）**：
- Modify: `DESIGN.md` §报表中心特定约定（66-69 行）

**前端视觉（T2）**：
- Modify: `web/app/reports/targets/[id]/page.tsx`（PC/mobile 容器宽度）
- Modify: `web/app/reports/targets/[id]/loading.tsx`（骨架宽度对齐）
- Modify: `web/components/report-center/region-drill-table.tsx`（sticky thead）
- Modify: `web/components/report-center/brand-metric-table.tsx`（sticky thead）
- Modify: `web/components/report-center/category-summary.tsx`（sticky thead + 去前导空格 + 合计行）
- Modify: `web/components/report-center/supply-chain-outbound-table.tsx`（sticky thead）
- Modify: `web/components/report-center/wholesale-daily-table.tsx`（sticky thead）
- Modify: `web/components/report-center/item-top-boards.tsx`（sticky thead）
- Modify: `web/components/report-center/item-outbound-list.tsx`（sticky thead + 表格风格统一 text-xs+divide-y）
- Modify: `web/components/report-center/item-detail-drawer.tsx`（blue-400->blue-600 + ChartActions）

**前端交互（T3）**：
- Modify: `web/components/report-center/item-top-boards.tsx`（useItemDayBoards 加 AbortController）
- Modify: `web/components/report-center/item-outbound-list.tsx`（列排序 + 行点开弹层 + URL 同步 + 分页图标）
- Modify: `web/components/report-center/wholesale-daily-table.tsx`（▾/▸ 换 lucide Chevron）

**数据库（T4）**：
- Modify: `database/migrations/118_achievement_delivery_include_ppf.sql`（outbound_profit_actual 脱敏 patch）

**生成器架构变更（T6）**：
- Modify: `services/semantic-generator/src/generators/tier1.ts:84`（dateUpper 逻辑）
- Modify: `services/semantic-generator/__tests__/tier1.test.ts`（extra_grain dateUpper 用例）
- Modify: `docs/architecture.md` §10.10（extra_grain dateUpper 文档）
- Create: `database/generated/report_wholesale_daily_customer_gen.sql`（重生成）

---

### Task 1: DESIGN.md 更新（三色+KPI 以实际为准）

**Files:**
- Modify: `DESIGN.md:66-69`（报表中心特定约定段）

**Why:** 视觉审查发现三色编码跨组件口径与 DESIGN.md 现文（"绿(>时间进度)"/"KPI卡用primary蓝"）不符，用户定"以实际代码为准，改 DESIGN.md"。不改代码，只对齐文档。

- [ ] **Step 1: 改 DESIGN.md 66-69 行**

把现有：
```
- **达成率三色编码**：绿(>时间进度) / 琥珀(接近 80-99%) / 红(<80% 落后)--零售达成特色
- **看板三段式**：KPI 大数字卡 -> 图表（趋势/排行）-> 类 Excel 交叉表 + 明细下钻
- **类 Excel 交叉表**：tabular-nums + 维度切换（行/列各一维）+ 点单元格下钻 + 战区/二级区域合并单元格
- **KPI 卡**：达成率用 primary 蓝，落后/差额用 error 红，跑赢进度用 success 绿小字标注
```

改为：
```
- **达成率三色编码（默认）**：按绝对达成率 -- 绿(≥100%) / 琥珀(80-99%) / 红(<80%)；progress（时间进度）仅作副信息文本，不参与着色。零售达成特色。
- **达成率三色编码（战区下钻表特例）**：rate < progress（落后时间进度）即红，其余按绝对值（≥1绿/≥0.8琥珀/<0.8红）。
- **看板三段式**：KPI 大数字卡 -> 图表（趋势/排行）-> 类 Excel 交叉表 + 明细下钻
- **类 Excel 交叉表**：tabular-nums + 维度切换（行/列各一维）+ 点单元格下钻 + 战区/二级区域合并单元格
- **KPI 卡**：达成率大数字直接套三色编码（绿/琥珀/红，同上规则），progress 作副信息小字标注。
- **毛利率标红（二元）**：配送/出库门店行毛利率 <12% 标红；批发毛利率 <0（负毛利）标红。无琥珀过渡档。
```

- [ ] **Step 2: 加 Decisions Log 行**

在 DESIGN.md `## Decisions Log` 表末加：
```
| 2026-08-02 | 三色编码+KPI卡以实际代码为准 | 审查发现文档与实现不符；用户定改文档不改代码，避免无谓返工 |
```

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): 三色编码+KPI卡色规以实际代码为准更新（绿/琥珀/红绝对值，KPI大数字套三色）"
```

---

### Task 2: 视觉 polish（sticky thead + 容器宽度 + 表格风格统一 + drawer）

**Files:**
- Modify: `web/app/reports/targets/[id]/page.tsx:93`（PC 容器）+ mobile 容器
- Modify: `web/app/reports/targets/[id]/loading.tsx`（骨架宽度对齐）
- Modify: 7 个表格组件（sticky thead）：region-drill/brand-metric/category-summary/supply-chain/wholesale-daily/item-top-boards/item-outbound-list
- Modify: `web/components/report-center/item-outbound-list.tsx`（风格统一 text-xs+divide-y）
- Modify: `web/components/report-center/item-detail-drawer.tsx`（blue-400->blue-600 + ChartActions）
- Modify: `web/components/report-center/category-summary.tsx`（去前导空格 + 合计行）

**Why:** 7 表格无 sticky thead（长表格滚动丢表头，BI 大忌）；PC 外壳无 max-w-[1100px] 与 DESIGN「看板 1100px 居中」冲突且与 loading 骨架 max-w-7xl 不一致致闪跳；item-outbound-list 用 text-sm+border 与其余 6 表 text-xs+divide-y 不一致；item-detail-drawer 趋势条 blue-400 偏淡不符主色 #1E40AF、弹层缺 ChartActions。

- [ ] **Step 1: PC 容器加 max-w（page.tsx:93）**

把 `<div className="p-6">` 改为 `<div className="mx-auto max-w-[1100px] p-6">`。

- [ ] **Step 2: mobile 容器加 max-w（page.tsx MobileDashboard 外壳）**

找到 MobileDashboard 包裹的 `<div className="min-h-screen bg-gray-50">`（约 114 行），在其内层加 `max-w-md mx-auto`（或确认 mobile.tsx 顶层容器，加 `mx-auto max-w-md px-3`）。

- [ ] **Step 3: loading.tsx 宽度对齐**

`web/app/reports/targets/[id]/loading.tsx` PC 骨架若用 `max-w-7xl` 改为 `max-w-[1100px]`，mobile 骨架 `max-w-md` 保持（确认与实际页一致，消除闪跳）。

- [ ] **Step 4: 7 表格加 sticky thead（统一模式）**

对每个表格的滚动容器与 thead 应用：
- 滚动容器（`overflow-x-auto` 的 div）改 `max-h-[28rem] overflow-auto`（长表 region/supply/wholesale/item-list）；短表（brand/category/item-top TOP20）可仅加 `overflow-x-auto` 不限高。
- thead 的 `<tr>` 加 `sticky top-0 z-10 bg-slate-50`（确保 thead 行有 bg，否则透明穿帮）。

7 文件清单（逐个改 thead tr className）：
1. `region-drill-table.tsx` thead tr -> `sticky top-0 z-10 bg-slate-50`
2. `brand-metric-table.tsx`
3. `category-summary.tsx`
4. `supply-chain-outbound-table.tsx`
5. `wholesale-daily-table.tsx`
6. `item-top-boards.tsx`（月榜+日榜两个表）
7. `item-outbound-list.tsx`

- [ ] **Step 5: item-outbound-list 表格风格统一**

`item-outbound-list.tsx:135` 把 `<table className="w-full border-collapse text-sm tabular-nums">` 改为 `<table className="w-full text-xs tabular-nums">`；`<thead><tr className="bg-slate-50 text-xs text-slate-500">` 已对齐；tbody `<tr className="hover:bg-slate-50">` 把 `<td className="border border-slate-200 p-2 ...">` 改为 `<td className="px-3 py-2 ...">`（去 border，用 divide-y）。表格外层加 `divide-y divide-slate-100`。

- [ ] **Step 6: item-detail-drawer 趋势条颜色 + ChartActions**

`item-detail-drawer.tsx:193` 把 `bg-blue-400 hover:bg-blue-600` 改为 `bg-blue-600 hover:bg-blue-700`（贴主色 #1E40AF=blue-800，blue-600 最近可用 tailwind 档）。
标题栏右侧加 `<ChartActions onExcel={handleExcel} onImage={handleImage} />`（Excel 导日趋势+品牌分布；图片导出弹层）。需 `import { ChartActions, exportExcel, exportImage } from "./chart-actions"` + 实现 handleExcel/handleImage（参考 item-top-boards.tsx:330-348 模式）。

- [ ] **Step 7: category-summary 去前导空格 + 合计行**

`category-summary.tsx:70-80` 表头文案去前导空格（如 ` 月销售目标` -> `销售目标`，靠 `text-right` 对齐）。末行加 tfoot 合计行（SUM 各列，参考 supply-chain-outbound-table 的 total_row 模式）。

- [ ] **Step 8: tsc 验证**

Run: `cd web && npx tsc --noEmit`
Expected: 0 error

- [ ] **Step 9: Commit**

```bash
git add web/app/reports/targets/\[id\]/page.tsx web/app/reports/targets/\[id\]/loading.tsx web/components/report-center/*.tsx
git commit -m "style(reports): 视觉polish--7表sticky表头+容器宽度1100px+表格风格统一+drawer主色/导出"
```

---

### Task 3: 交互 polish（切日竞态 + 列排序 + 行点开弹层 + lucide + URL + 分页图标）

**Files:**
- Modify: `web/components/report-center/item-top-boards.tsx:255-305`（useItemDayBoards AbortController）
- Modify: `web/components/report-center/item-outbound-list.tsx`（列排序 + 行点开 ItemDetailDrawer + URL 同步 + 分页图标）
- Modify: `web/components/report-center/wholesale-daily-table.tsx:179`（▾/▸ 换 lucide Chevron）

**Why:** 切日无 AbortController 致快速切换时旧响应覆盖新（竞态）；出库明细列不可排序、行不可点开商品弹层（明细表最该能下钻）；wholesale-daily 用 ▾/▸ 与 region/supply 的 lucide Chevron 不一致；筛选/分页不在 URL 刷新丢失；分页纯文字无图标。

- [ ] **Step 1: useItemDayBoards 加 AbortController（item-top-boards.tsx）**

把 `onDayChange`（269-302 行）改为（加 ctrlRef 取消上次请求）：

```ts
const ctrlRef = useRef<AbortController | null>(null);
const onDayChange = async (d: string) => {
  if (!d || d === day) return;
  ctrlRef.current?.abort();
  const ctrl = new AbortController();
  ctrlRef.current = ctrl;
  setDay(d);
  setBusy(true);
  setError(null);
  try {
    const [sRes, oRes] = await Promise.all([
      fetch("/api/admin/reports/item-top", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, date: d, metric: "sale" }),
        signal: ctrl.signal,
      }).then((r) => r.json()),
      fetch("/api/admin/reports/item-top", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, date: d, metric: "outbound" }),
        signal: ctrl.signal,
      }).then((r) => r.json()),
    ]);
    setBoards({
      sale: sRes?.board ?? { rows: [], totalAmount: 0, totalProfit: 0 },
      outbound: oRes?.board ?? { rows: [], totalAmount: 0, totalProfit: 0 },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    setError("日榜加载失败");
  } finally {
    if (!ctrl.signal.aborted) setBusy(false);
  }
};
```

确认 `useRef` 已 import（item-top-boards.tsx 顶部，应已有 `import { useRef, useState } from "react"`）。

- [ ] **Step 2: wholesale-daily ▾/▸ 换 lucide Chevron（wholesale-daily-table.tsx）**

文件顶部加 `import { ChevronDown, ChevronRight } from "lucide-react";`（若无）。
line 179 `{isOpen ? "▾" : "▸"}` 改为：
```tsx
{isOpen ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
```

- [ ] **Step 3: item-outbound-list 列排序（客户端排序）**

`item-outbound-list.tsx` 加 sort state：
```ts
const [sortKey, setSortKey] = useState<"outbound"|"delivery"|"wholesale"|"name">("outbound");
const [sortDir, setSortDir] = useState<"asc"|"desc">("desc");
```
渲染前对 rows 排序（不 mutate 服务端返回）：
```ts
const sortedRows = [...rows].sort((a, b) => {
  const av = sortKey === "name" ? (a.item_name ?? "") : (a[`${sortKey}_amount`] ?? 0);
  const bv = sortKey === "name" ? (b.item_name ?? "") : (b[`${sortKey}_amount`] ?? 0);
  if (typeof av === "string" || typeof bv === "string") return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
});
```
表头 `<th>` 加 `onClick` 切换 sortKey/sortDir + 排序指示图标（`ChevronUp`/`ChevronDown` lucide，当前列显示）。渲染用 `sortedRows.map(...)` 替换 `rows.map(...)`。

- [ ] **Step 4: item-outbound-list 行点开 ItemDetailDrawer**

list 内嵌 drawer state（参考 item-top-boards.tsx:328 drawer 模式）：
```ts
const [drawer, setDrawer] = useState<string | null>(null);
```
行 `<tr key={r.item_code} className="hover:bg-slate-50 cursor-pointer" onClick={() => setDrawer(r.item_code)}>`。
组件末尾加：
```tsx
{drawer && (
  <ItemDetailDrawer itemCode={drawer} targetId={targetId} onClose={() => setDrawer(null)} />
)}
```
`import { ItemDetailDrawer } from "./item-detail-drawer";`

- [ ] **Step 5: item-outbound-list 筛选/分页同步 URL**

用 `useSearchParams` + `useRouter`（next/navigation）把 category/q/page 同步到 URL query：
```ts
import { useSearchParams, useRouter, usePathname } from "next/navigation";
const searchParams = useSearchParams();
const router = useRouter();
const pathname = usePathname();
// 初始化从 URL 读
const [page, setPage] = useState<number>(Number(searchParams.get("page")) || 1);
const [filters, setFilters] = useState({ category: searchParams.get("category") || "", q: searchParams.get("q") || "" });
// fetchPage 成功后更新 URL
const updateUrl = (p: number, f: typeof filters) => {
  const params = new URLSearchParams();
  if (f.category) params.set("category", f.category);
  if (f.q) params.set("q", f.q);
  if (p > 1) params.set("page", String(p));
  router.replace(`${pathname}?${params.toString()}`, { scroll: false });
};
```
在 fetchPage 末尾 + onFilterChange 调 updateUrl。

- [ ] **Step 6: 分页加图标**

`item-outbound-list.tsx:191-207` 上一页/下一页按钮加 lucide 图标：
```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
// 上一页
<button ...><ChevronLeft size={14} strokeWidth={1.5} /></button>
// 下一页
<button ...><ChevronRight size={14} strokeWidth={1.5} /></button>
```

- [ ] **Step 7: tsc 验证**

Run: `cd web && npx tsc --noEmit`
Expected: 0 error

- [ ] **Step 8: Commit**

```bash
git add web/components/report-center/item-top-boards.tsx web/components/report-center/item-outbound-list.tsx web/components/report-center/wholesale-daily-table.tsx
git commit -m "feat(reports): 交互polish--切日AbortController+明细列排序/行点开弹层+▾▸换lucide+URL同步+分页图标"
```

---

### Task 4: P0-1 数据 bug patch（118 outbound_profit 脱敏）

**Files:**
- Modify: `database/migrations/118_achievement_delivery_include_ppf.sql:79`

**Why:** 118 手写视图 `outbound_profit_actual = SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0))` 无 CASE can_see_cost，其它 _gen 视图均脱敏。当前因临时 can_see_cost=true 无泄露，一旦收口 role_id 即裸奔。KPI 卡用此视图。

- [ ] **Step 1: patch outbound_profit_actual 脱敏**

`database/migrations/118_achievement_delivery_include_ppf.sql` line 78-79，把：
```sql
  SELECT SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
    SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) AS outbound_profit_actual,
```
改为（仅 profit 包 CASE，amount 不敏感）：
```sql
  SELECT SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
      THEN SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) ELSE NULL END AS outbound_profit_actual,
```

确认 line 10 幂等注释已是 `DROP VIEW IF EXISTS + CREATE VIEW`（118 现有，视图列不变可 OR REPLACE，但保持 DROP+CREATE 一致 migrate.sh 重跑安全）。

- [ ] **Step 2: prod 跑迁移 + restart postgrest**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-postgres-1 psql -U postgres -d insforge -f -" < database/migrations/118_achievement_delivery_include_ppf.sql
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: 验证脱敏生效**

```bash
# postgres 角色（无 can_see_cost）应返 NULL
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT metric_code, actual_value FROM report_achievement_v WHERE target_id=22 AND metric_code='outbound_profit';\""
```
Expected: actual_value = NULL（postgres 角色无 can_see_cost GUC，脱敏生效）。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/118_achievement_delivery_include_ppf.sql
git commit -m "fix(reports): 118 outbound_profit 成本脱敏patch（CASE can_see_cost，与_gen视图对齐）"
```

---

### Task 5: Phase 1 部署 + E2E 验证

**Files:** 无新文件（部署 T1-T4 改动）

- [ ] **Step 1: push 走 GHA**

```bash
git push origin main  # 若 403 用 git -c http.proxy=socks5h://127.0.0.1:7897 -c https.proxy=socks5h://127.0.0.1:7897 push origin main
```

- [ ] **Step 2: 监控 GHA**

```bash
gh run list --limit 3
gh run watch <run-id>
```
Expected: 5 steps 全绿（rsync+后端+迁移+functions+前端）。

- [ ] **Step 3: E2E 验证**

- 前端可达：`curl -s https://data.shanhaiyiguo.com` 返 200
- API 健康：`curl -s https://data.shanhaiyiguo.com/api/health`
- 118 脱敏：DB 查 outbound_profit actual_value=NULL（postgres 角色）
- 页面渲染：企微打开 `/reports/targets/22`，9 区块正常
- sticky thead：长表滚动表头固定
- 切日：快速切日无错乱（AbortController）
- 出库明细：列头点击排序、行点击开弹层、刷新保持筛选（URL）
- wholesale 下钻：日期行 ▾/▸ 已换 lucide Chevron
- DESIGN.md：色规已按实际更新

- [ ] **Step 4: 企微视觉验证（用户）**

用户企微打开 `/reports/targets/22` 确认视觉/交互。

---

### Task 6: P0-3 dateUpper 生成器架构变更（extra_grain biz_date 用 latest_day）

**Files:**
- Modify: `services/semantic-generator/src/generators/tier1.ts:84`
- Test: `services/semantic-generator/__tests__/tier1.test.ts`
- Modify: `docs/architecture.md` §10.10
- Create: `database/generated/report_wholesale_daily_customer_gen.sql`（重生成）

**Why:** tier1.ts:84 `dateUpper = dim_code === 'date' ? 'tgt.latest_day' : 'tgt.end_date'`。下钻视图 `dim_code='customer'`+`extra_grain=['s.biz_date']` 是时间序列，但落到 end_date（全周期含未来），与主视图（dim_code='date' 用 latest_day）不一致。当前单天下钻侥幸一致，未来日期有提前录入批发单时下钻 SUM>主视图。注释（83 行）自述 date grain 用 latest_day，extra_grain 时间序列漏判。

**架构变更**（铁律）：改生成器 tier1.ts = 架构变更。先更新 architecture.md -> 用户同意（本 plan 即同意）-> 再执行。

- [ ] **Step 1: 更新 architecture.md §10.10**

`docs/architecture.md` §10.10 extra_grain 段补一句：
```
extra_grain 含 biz_date（时间序列双 grain，如客户×日期下钻）时，dateUpper 同 dim_code='date' 用 tgt.latest_day 上限（至当日，非全周期 end_date）。
```

- [ ] **Step 2: 写失败测试（tier1.test.ts）**

加用例：extra_grain=['s.biz_date'] + dim_code='customer' 时，生成的 SQL 中 target_window join 上界用 `tgt.latest_day` 而非 `tgt.end_date`。

```ts
test("extra_grain biz_date uses latest_day upper bound", () => {
  const config: ViewConfig = {
    view_name: "test_extra_grain_date",
    metrics: ["wholesale_ext_customer_amount"],
    dim_code: "customer",
    extra_grain: ["s.biz_date"],
    carry_cols: ["client_name"],
    scope: { target_window: true, target_status: ["active", "closed"] },
    total_row: false,
  };
  const sql = generateView(config, metrics, sources);
  expect(sql).toContain("tgt.latest_day");
  expect(sql).not.toContain("tgt.end_date");
});
```
Run: `cd services/semantic-generator && npx vitest run __tests__/tier1.test.ts -t "extra_grain biz_date"`
Expected: FAIL（当前生成 end_date）。

- [ ] **Step 3: 改 tier1.ts:84**

```ts
// 现（line 84）
const dateUpper = dim_code === 'date' ? 'tgt.latest_day' : 'tgt.end_date';
// 改为
const dateUpper = (dim_code === 'date' || extraGrainCols.includes('s.biz_date'))
  ? 'tgt.latest_day' : 'tgt.end_date';
```

- [ ] **Step 4: 测试通过**

Run: `cd services/semantic-generator && npx vitest run __tests__/tier1.test.ts`
Expected: PASS（含新用例 + 全部既有用例）。

- [ ] **Step 5: 全量测试**

Run: `cd services/semantic-generator && npm test`
Expected: 全绿。

- [ ] **Step 6: 重生成 SQL（SSH 隧道连 prod metric_registry）**

```bash
cd services/semantic-generator
# 建 prod 隧道（postgres 容器 IP 172.18.0.4，密码在 deploy/.env 非 dev-postgres-pw）
ssh -i ~/.ssh/ShanHai-OPS.pem -L 15433:172.18.0.4:5432 root@data.shanhaiyiguo.com -N &
# .env 指向 prod（PG_HOST=localhost PG_PORT=15433 + prod 密码）
npm run gen-views
```
Expected: `database/generated/report_wholesale_daily_customer_gen.sql` 重生成，其中 `BETWEEN tgt.start_date AND tgt.latest_day`（验证不再是 end_date）。

- [ ] **Step 7: prod 跑视图 + restart postgrest + L3b**

```bash
# 隧道还在，跑视图
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -f -" < database/generated/report_wholesale_daily_customer_gen.sql
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
# L3b: 主视图 vs 下钻视图 SUM 仍等（1960965.80）
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT (SELECT SUM(wholesale_ext_customer_amount) FROM report_wholesale_daily_customer_gen WHERE target_id=22) AS drill, (SELECT SUM(wholesale_ext_amount) FROM report_wholesale_daily_gen WHERE target_id=22) AS main;\""
```
Expected: drill = main = 1960965.80（diff=0）。

- [ ] **Step 8: Commit + push**

```bash
git add services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/tier1.test.ts docs/architecture.md database/generated/report_wholesale_daily_customer_gen.sql
git commit -m "fix(generator): extra_grain biz_date 日期上界用latest_day（架构变更§10.10）--修下钻视图与主视图口径一致"
git push origin main
```

- [ ] **Step 9: GHA + E2E**

监控 GHA 全绿；企微验证下钻 SUM 与主视图一致。

---

## 不修（设计取舍 / 数据层限制 / follow-up）

- **outbound 口径不一致（原 P0-2）**：DB 验证无悖论（outbound>delivery），属 brand-ledger-external-customer 待改造领域（品品甜=熊喵外部客户，配送走批发口径），随目标管理改造一并解决。
- **ItemTop/ItemOutboundList sale 不过滤考核**：item 级无 branch_num 维度，数据层限制。建议前端标注「含非考核门店销售」（可加在 T2/Task2 表头 tooltip）。
- **brand_metric 64188 sale_target=0**：目标管理待改造已知项。

## Follow-up Plans（本 plan 不含，单独排期）

- **T7 join_override**：先 DB 验证 64188 品品甜批发单 `report_daily_wholesale_customer.branch_num` 是否匹配 `dim_branch.branch_num`（64188 门店）。若不匹配则 brand_metric_gen/region_breakdown_gen 丢品品甜批发数据，需生成器加 `branch_join_override` 能力（client_name->branch_name，对齐 wholesaleCustomerView 的 extra_join）。属架构变更，单独 plan。
- **T8 KPI 切生成器**：为 KPI 卡补 view-config（sale/delivery/outbound_amt/outbound_profit 4 指标），前端切 _gen 视图弃 118 手写视图。根治 P0-1 脱敏 + 收口双轨。工作量大，单独 plan。

## 决策记录

- **三色+KPI 色规**：用户定"以实际代码为准，改 DESIGN.md 不改代码"（避免无谓返工）。实际：默认绝对值三色（≥1绿/≥0.8琥珀/<0.8红），战区表特例"落后进度即红"，KPI 大数字套三色，毛利率二元标红。
- **P0-2 降级**：DB 核验推翻 agent"outbound<delivery 悖论"推理（target22 outbound 21.24M > delivery 19.28M），降为 brand-ledger 设计取舍。**验证优于 agent 推理**。
- **lucide 换 ▾/▸**：统一图标库（DESIGN「统一用一套」），region/supply 已用 lucide Chevron，wholesale 是 outlier。
- **T6 架构变更路径**：改生成器 tier1.ts dateUpper，符合铁律第2条（config 无法表达 extra_grain 时间序列上界，须改生成器）。先更新 architecture.md 再执行。
- **T7/T8 分离**：T7 需 DB 验证才能定是否实施，T8 较大，单独 plan 不混入本 plan。

## 风险

- **sticky thead 容器限高**：`max-h-[28rem]` 改变长表 UX（表内滚动 vs 页滚）。若用户偏好页滚，可退化为仅 `sticky top-0`（视口sticky需外层非 overflow 限制，复杂）。先按 max-h+overflow-auto 实现，企微验证可调。
- **118 patch 幂等**：118 现有 `DROP VIEW IF EXISTS + CREATE VIEW`，视图列不变（仅 profit 包 CASE），migrate.sh 重跑安全。
- **T6 重生成需 prod 隧道**：gen-views 连 prod metric_registry，密码在 deploy/.env（非 dev-postgres-pw），隧道指容器 IP 172.18.0.4。
- **T6 L3b 验证**：主视图与下钻视图 SUM 须等（1960965.80）。若不等说明 dateUpper 改动影响主视图（不应，主视图 dim_code='date' 原本就用 latest_day）。
- **URL 同步（T3 Step5）**：`useSearchParams` 需 Suspense 边界（Next.js 15），确认 page.tsx 已包 Suspense 或 list 组件加 `<Suspense>`。
