# 报表中心全面移动端适配 — 设计规格

- 日期：2026-08-03
- 范围：消费者面向的报表页（首页目标列表 `/`、看板 `/reports/targets/[id]`、点行下钻抽屉）。**不含** `/admin/*`（运营在 PC 后台管）。
- 关联：`DESIGN.md`（字体/色彩/三色编码/报表约定）、`CLAUDE.md`（部署/架构规则）、记忆 `flash-pc-link-prefetch.md`（移动闪 PC 坑）、`frontend-presentation.md`（Phase2 双端）。

## 1. 背景与现状

报表中心已有"服务端设备检测 + Mobile/Desktop 分壳"架构，但移动端体验存在基础缺陷与宽表硬伤。

### 1.1 现有架构（扎实，沿用）
- **服务端设备检测**：`web/middleware.ts` 按 UA 判定 → 注入 `x-device-type` 请求头 + `device_type` cookie（30 天）。`web/lib/get-device-type.ts` 三级回退（header → cookie → UA），SSR 安全。
- **分壳渲染**：`web/app/page.tsx`（首页）与 `web/app/reports/targets/[id]/page.tsx`（看板）均为 Server Component，调 `getDeviceType()` 后分别渲染 mobile/desktop 外壳。看板页取数后分发 `<MobileDashboard>` / `<DesktopDashboard>`（`web/app/reports/targets/[id]/{mobile,desktop}.tsx`）。
- `MobileDashboard` 把同一批报表组件纵向堆叠（`px-4`）。
- `web/app/mobile/*` 旧路由已废弃 → redirect。

### 1.2 致命基础缺失
1. **无 viewport meta**：`web/app/layout.tsx` 只 `export const metadata`，缺 `export const viewport`。→ 移动端按 980px 布局视口渲染，一切"桌面缩小"而非真移动。**头号元凶，不修则后续全无效。**
2. **无客户端设备感知**：宽表组件是 `'use client'`，但拿到的是与桌面**同一份 markup**，仅靠 Tailwind 响应式类；而宽表无响应式变体，只有 `overflow-x-auto`。

### 1.3 组件移动就绪度（实测）

| 组件 | 文件 | 列数 | 移动现状 |
|---|---|---|---|
| KpiCards | `kpi-cards.tsx` | — | ✅ `grid-cols-2 md:grid-cols-4`；但 tooltip 是 `group-hover`（移动无 hover） |
| ItemTopBoards | `item-top-boards.tsx` | — | ✅ `grid-cols-1 md:grid-cols-2` 单列堆叠 |
| CategoryItemDrawer / ItemDetailDrawer | `category-item-drawer.tsx` / `item-detail-drawer.tsx` | — | ✅ `w-full md:w-[720px]` / `max-w-[92vw]` 移动全屏/限宽 |
| TargetList（首页） | `target-list.tsx` | — | ✅ 已单列 `grid gap-3` + `prefetch={false}`；`px-5` 略宽 |
| WholesaleDailyTable | `wholesale-daily-table.tsx` | 4 列 + 日期下钻 | ⚠️ 4 列可放下；`max-h-[28rem]` 限高 + 内联客户子表窄屏挤 |
| BrandMetricTable | `brand-metric-table.tsx` | 7 列 / 3 行 | ⚠️ `min-w-[640px]` 强制宽 → 横滚（行少影响小） |
| SupplyChainOutboundTable | `supply-chain-outbound-table.tsx` | 7 列 + 三级树 | ❌ 横滚；树缩进挤；store 行毛利率<12% 标红 |
| CategorySummary | `category-summary.tsx` | 12 列 | ❌ 严重横滚；行 tap 已开商品明细抽屉 |
| RegionDrillTable | `region-drill-table.tsx` | 13 列 + 三级树 | ❌ 最严重：横滚 + 表头滚没 + 首列不固定 |
| ChartActions | `chart-actions.tsx` | — | ❌ 移动端照常显 Excel/图片/分享，违反 DESIGN「移动只生成分享图」 |

### 1.4 外壳问题
- 全局 `Header`（`web/components/layout/header.tsx`，`h-16 px-6`）：移动端平台名 + Beta + 姓名 + 头像 + 退出挤一排，375px 下拥挤。`MobileDashboard` 内又有 sticky 子头（←报表中心 + 目标名 + 日期），**双 Header 叠压**首屏。

## 2. 已确认的关键决策

| 决策点 | 选定 | 备选（已否） |
|---|---|---|
| 宽表移动方案 | **B 精简表 + 点行展开** | A 横滚增强（13列仍密集）/ C 卡片重排（双倍代码） |
| 适配范围 | **全部消费者报表页**（看板 7 组件 + 首页列表 + 下钻抽屉） | 只看板 / 连 admin |
| 看板结构 | **优先级长滚动**（KPI→关键表→进阶表） | 手风琴 / Tab 分组 |
| 设备感知机制 | **① prop 下传 `isMobile`** | ② 客户端 hook（hydration 闪烁）/ ③ 独立移动组件（双倍代码） |
| ChartActions 移动端 | **只留"分享图"**（遵循 DESIGN） | — |

## 3. 设计

### 3.1 地基修复（前提）

**viewport meta**：`web/app/layout.tsx` 新增
```ts
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
```
（Next App Router 方式；不加 `maximumScale: 1`，保留无障碍缩放。）

### 3.2 设备感知机制（方案 ① prop 下传）

- 给需要移动变体的组件新增 `isMobile?: boolean` prop。
- `MobileDashboard` 渲染这些组件时传 `isMobile`（MobileDashboard 仅在移动端被渲染，天然移动上下文）；`DesktopDashboard` 不传 → 默认 `false`，桌面分支**完全不动**（低风险）。
- 组件内 `{isMobile ? <MobileLayout/> : <DesktopLayout/>}`，**共享逻辑（建树/格式化/合计/导出 handler）抽到同文件的子组件或上层 useMemo**，两套布局只负责渲染。
- **不引入**客户端 `useIsMobile` hook：会引入 hydration 不一致 → 闪烁（记忆 `flash-pc-link-prefetch.md` 同类坑），与现有服务端判定架构相悖。

### 3.3 外壳 / 导航

- **合并双 Header**：全局 `Header` 移动端简化——`px-4`、隐 Beta 徽章、高度压到 `h-12`；企微内本就隐退出按钮（`isWecomClient` 已处理）。`MobileDashboard` 内 sticky 子头保留（承载返回 + 目标上下文）。
- **不加底部 Tab 导航**：报表中心是"列表 → 看板 → 返回"线性流，底部 Tab 是多余层级，与"优先级长滚动"一致。

### 3.4 宽表移动通用模式（B：精简 + 点行展开）

移动端宽表统一为：
1. **精简表**：只显身份列 + 2~3 个关键达成率列；身份列 + 表头 `position: sticky`。
2. **点行 → 底部抽屉看全部字段**：抽屉内用 label-value 竖排展示该行完整字段（复用现有 Drawer 风格，`w-full` 移动全屏）。不用内联手风琴展开（会撑乱 sticky 表头）。

**移动端交互模型（解决与既有 row-tap 行为的冲突）**：
- 既有行为：树形表（Region/SupplyChain）行 tap = 展开子级；CategorySummary 行 tap = 开商品明细抽屉。
- 移动端统一为**两个独立 tap 区**，互不冲突：
  - 左侧 **hierarchy chevron**（仅父级行有，tap target ≥32px）= 展开/折叠子级（树形表保留此交互）。
  - 行末 **details chevron ▸**（唯一的全字段抽屉触发器，不在行 body 上挂 tap，避免与树展开/商品明细下钻撞）= 打开"全字段详情抽屉"。
- CategorySummary 特例：行 tap 现开**商品明细**（高价值下钻，保留）。其品类自身的其余字段（目标/毛利目标等）通过行末 ▸ 进"全字段抽屉"查看；因品类仅 ~4 行，精简 4 列已覆盖扫视需求，全字段为次要。

**逐表精简列**（已对齐真实字段）：

| 表 | 移动精简列 | 全字段抽屉来源 |
|---|---|---|
| RegionDrillTable | 门店/区名 · 销售完成率(三色) · 配送完成率(三色) · 当天销售 | 13 字段全量 |
| CategorySummary | 类别 · 销售完成率 · 毛利率(<12%红) · 当天出库 | 12 字段全量 |
| SupplyChainOutboundTable | 名称 · 出库金额 · 毛利率(<12%红) · 当天出库 | 7 字段全量 |
| BrandMetricTable | （3 行）去 `min-w-[640px]`，保留 7 列自适应窄屏（缩 padding/字号） | — |
| WholesaleDailyTable | （4 列）去 `max-h-[28rem]` 限高随页滚；内联客户子表响应式 `w-full` | 日期下钻保留 |

### 3.5 ChartActions（导出条）

`ChartActions` 加 `isMobile?: boolean`。移动端（`isMobile`）只渲染 `onImage`（分享图），隐藏 Excel（企微 webview 下 xlsx 体验差）与分享链接。遵循 DESIGN「移动端只生成分享图（卡片图转企微）」。桌面分支不动。

### 3.6 已适配组件微调

- **KpiCards**：移动端**隐藏 hover tooltip**（卡片已常显完成率大数字 + 实际/目标/进度副信息，tooltip 冗余）；`data_status` 英文徽章（complete/partial/missing/not_ready）移动端中文化（已完成/部分/缺失/未就绪）。
- **ItemTopBoards**（单列堆叠）✅ 不动。
- **CategoryItemDrawer / ItemDetailDrawer**（移动全屏）✅ 不动。
- **首页 TargetList**：`px-5` → `px-4`；确保状态/类型徽章在 375px 不溢出（badge 已 `whitespace-nowrap`，name `truncate`，OK）。其余不动。

### 3.7 企微 webview

- `isWecomClient` 已用于隐退出按钮，沿用。
- 分享图：html2canvas 截图（`chart-actions.tsx` 现为下载 png）。企微内引导"长按图片保存/转发"（提示文案）；是否接入企微 JSSDK 分享为后续增强，**本期不做**（YAGNI），仅保证截图生成 + 长按保存可用。

## 4. 文件级改动清单

| 文件 | 改动 |
|---|---|
| `web/app/layout.tsx` | 新增 `export const viewport` |
| `web/components/layout/header.tsx` | 移动端简化（`px-4`/隐 Beta/`h-12`），按设备分支 |
| `web/app/reports/targets/[id]/mobile.tsx` | 给各子组件传 `isMobile`；精简表 + 全字段抽屉接入 |
| `web/app/reports/targets/[id]/desktop.tsx` | 不传 `isMobile`（默认桌面，零改动验证） |
| `web/components/report-center/region-drill-table.tsx` | 加 `isMobile`；移动精简表 + 行末 ▸ 全字段抽屉；树 chevron 与详情 tap 分离 |
| `web/components/report-center/category-summary.tsx` | 加 `isMobile`；移动精简表；行 tap 保留商品明细，行末 ▸ 进全字段抽屉 |
| `web/components/report-center/supply-chain-outbound-table.tsx` | 加 `isMobile`；移动精简表 + 行末 ▸ 全字段抽屉；树 chevron 分离 |
| `web/components/report-center/brand-metric-table.tsx` | 去 `min-w-[640px]`，窄屏自适应 |
| `web/components/report-center/wholesale-daily-table.tsx` | 去 `max-h-[28rem]`；内联客户子表 `w-full` 响应式 |
| `web/components/report-center/chart-actions.tsx` | 加 `isMobile`；移动端只渲染 `onImage` |
| `web/components/report-center/kpi-cards.tsx` | tooltip 移动端可达；状态徽章中文化 |
| `web/components/report-center/target-list.tsx` | `px-5`→`px-4`，窄屏徽章核验 |
| 新增 `web/components/report-center/row-detail-drawer.tsx`（暂定名） | 通用"全字段详情抽屉"（label-value 竖排，`w-full` 移动全屏），供三个宽表复用 |

> 改动限于 `web/` 前端，**不涉及 `database/`、`deploy/`、`services/`、`functions/`** → 按 CLAUDE.md 部署规则走 **GHA 完整部署**（push 触发）。

## 5. 验证

- **Playwright 移动视口**（375×812，iPhone 12）：每个宽表的精简列、行末 ▸ 全字段抽屉、树 chevron、ChartActions 只显分享图、KpiCards tooltip 可达。
- **真机企微客户端**：通过生产 URL 验证登录、分享图长按保存、无 PC 闪屏。
- **回归红线**：
  - 无 hydration 闪烁 / 首屏不闪 PC（记忆坑）。
  - 桌面端零回归（`isMobile` 默认 false，桌面分支不动）。
  - 三色编码、毛利率<12%/<0 标红、tabular-nums 对齐（DESIGN）不破。
  - 数据口径不变（纯前端渲染层改动，不动取数/视图）。

## 6. 非目标（YAGNI）

- 不接企微 JSSDK 原生分享（本期仅截图 + 长按保存）。
- 不做暗色模式移动端（DESIGN 有 dark 定义但产品未启用）。
- 不适配 `/admin/*`。
- 不新增报表/指标，不改数据口径与语义层。
