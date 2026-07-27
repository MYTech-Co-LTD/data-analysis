# 目标管理版块 · UI 靠拢 / 术语治理 / 配销比 / 批量导入预览设计

> 日期：2026-07-27
> 范围：目标管理版块（录入端 `/admin/targets` + 达成端 `/reports/targets/[id]` + 共享组件）+ 前台 sidebar + 设置页清理
> 性质：**纯前端 UI/文案/交互 + 架构文档同步**，无数据库/接口/迁移改动
> 部署：改 `web/` + `docs/`，走 git push → GHA

---

## 1. 背景与目标

目标管理版块分两端：录入端（admin/targets）与达成端（reports/targets + report-center 共享组件）。现状两端视觉割裂、术语混用、录入端缺配销比与批量核对能力。

本轮目标：
1. **录入端向达成端视觉靠拢**（达成端是基准），配色/图标/容器/徽章统一到 DESIGN 体系
2. **治理术语**——权威中文术语表，消除「配送/出库」混用
3. **新增配销比**：录入端目标配销比（配送目标/销售目标，只读）+ 达成端配销比达成率（实际配销比/目标配销比，前端派生不落库）
4. **Excel 导入 diff 预览**——解决几百店批量修改后无法核对的痛点
5. **清理设置页**——前台 sidebar 去掉"设置"，删静态占位 `/settings`
6. 顺带修达成端既有问题（KPI 口径、死代码、补 DESIGN 要求的导出/分享）

明确非目标（本轮排除，记 backlog）：
- 录入端移动适配
- **移动端报表展示重设计**：独立子项目 B（下一个，高优先级），当前 spec 不含；共享组件（RegionDrillTable/KpiCards/CategorySummary）的改动移动端临时继承，待 B 用移动专用组件替换（详见 §12）
- 录入交互重构其余项：`confirm()`→弹窗、手动结案/复制/删除、子和校验信息去冗余、输入性能优化
- UI 按规则批量调整（比例缩放/固定值增减/配销比反推）、智能分摊（历史占比）
- 数据库字段名 / 视图列名 / RPC 参数改动
- admin layout 外壳整体配色统一（本轮只改前台 sidebar + 录入页内容区）

---

## 2. 术语治理

### 2.1 权威术语表

「出库」专指总部总仓全部出货 outbound（= 配送 + 批发）；delivery 统一叫「配送」（门店视角收货），不再叫出库。

| metric_code | 核心词 | 门店维度表用词 | KPI 简称 | 弃用别名 |
|---|---|---|---|---|
| `sale` | 销售 | 门店销售 / 月销售 | 销售 | ~~门店零售~~ |
| `delivery` | 配送 | 门店配送 / 月配送 | 配送 | ~~月出库、出库~~（达成端误用） |
| `wholesale` | 批发 | — | — | — |
| `outbound_amt` | 出库金额 | — | 出库金额 | 总仓出库金额（录入语境保留前缀） |
| `outbound_profit` | 出库毛利 | — | 出库毛利 | 总仓出库毛利（同上） |

「门店」/「月」前缀按维度场景保留做语境修饰，核心词统一。

### 2.2 作用域

**改 UI 展示文案 + Excel 导出表头 + DB 显示名 + 架构文档**。**不动**：`metric_code`、视图列名、前端变量名、RPC 参数。DB 仅改 `metric_definitions.name` / `metric_registry.name` 的显示值（迁移 077，幂等 UPDATE，在 068/076 之后执行覆盖 seed）。零数据风险（不改结构/code/公式）。

### 2.3 文件改动

| 文件 | 改动 |
|---|---|
| `web/lib/report-center/metric-source.ts` | `METRICS.label`：`门店零售→销售`、`门店配送→配送`、`总仓出库金额→出库金额`、`总仓出库毛利→出库毛利` |
| `web/components/report-center/region-drill-table.tsx` | 表头/列名「月出库→月配送」、标题「门店零售/出库→门店零售/配送」；Excel head 同步 + **修前导空格**（`" 月销售金额"`→`"月销售金额"`） |
| `web/components/report-center/category-summary.tsx` | outbound「出库」保持；仅修 Excel head 前导空格 |
| `web/app/admin/targets/page.tsx` | `STORE_METRICS.name`：`门店零售→门店销售`（sale）；`门店配送`保留（delivery，门店板块语境）；`HQ_METRICS.name`保留；**文案 bug line 84「4 个品类」→「3 个品类」** |
| `web/app/admin/targets/[id]/page.tsx` | `METRIC_NAME` 映射同步术语 |
| `database/migrations/077_term_governance.sql`（新建） | 幂等 UPDATE：`metric_definitions.name`（sale=销售/delivery=配送/outbound_amt=出库金额/outbound_profit=出库毛利）+ `metric_registry.name`（delivery_amount=配送金额/delivery_profit=配送毛利，修撞名 bug） |
| `docs/architecture.md §10.8` | 品类定义过时（「水果/标品耗材」→水果/标品/耗材 3 类）→ 修正；补权威术语表（同 2.1） |

---

## 3. 设置页清理

`/settings` 是纯静态占位页（企微集成全显"未配置"、平台信息过时如「对象存储 MinIO」实际天翼云 OOS），**无任何可编辑设置控件**。

- **删** `web/app/settings/page.tsx`
- **前台 sidebar 去掉「设置」菜单项**（已确认仅 sidebar 一处引用 `/settings`，无死链）
- 平台信息不保留（过时无价值）；未来真要做设置 → 挂 admin 侧栏已有的 disabled「系统设置」占位

---

## 4. 录入端视觉靠拢（A 档）

录入分解表保留全边框（密集数字录入定位需要），仅配色/容器/图标/徽章统一。

### 4.1 配色 gray → slate

`admin/targets/page.tsx` + `admin/targets/[id]/page.tsx`：

| 现 | 改 |
|---|---|
| `bg-gray-100`（表头） | `bg-slate-50` |
| `bg-gray-50`（合计/区域行） | `bg-slate-50/60` |
| `text-gray-400/500/600` | `text-slate-400/500/600` |
| `bg-black/40`（modal mask） | `bg-slate-900/40` |
| `border-gray-300` | `border-slate-300` |
| 表格 `border`（默认色） | `border-slate-200` |

### 4.2 容器卡片化

录入端裸 `<table>` 外层包卡片容器 `rounded-lg border border-slate-200 bg-white p-4`（参照 region-drill-table）。列表 table、新建 modal 内总部/门店板块 table、分解页品类表与门店三级表各包卡片。sticky 工具条保留不动（仅配色）。

### 4.3 状态徽章中文化

`admin/targets/page.tsx` 列表「状态」列：英文原值 → 中文徽章（参照 `target-list.tsx`）：`active→进行中(bg-blue-50 text-blue-700)` / `closed→已结束(bg-slate-100 text-slate-500)`。

### 4.4 字符图标 → lucide

`region-drill-table.tsx:134`（达成端）`"▼"/"▶"` → lucide `ChevronDown/ChevronRight`（录入端已用 lucide，统一）。

### 4.5 配销比（新增，只读自动计算）

按「配送目标 / 销售目标」，纯前端计算，不入库：

- **分解页门店三级表**（`[id]/page.tsx`）：在「门店配送」列后加列「配销比」
  - 门店行：`本店配送目标 / 本店销售目标`
  - 战区/区域行：同列显示子和比（下级配送汇总 / 销售汇总）
  - 格式：百分比 `toFixed(0)`（如 `40%`）；销售目标=0 → `—`
  - 只读文本（非 input），`tabular-nums`
- **顶部 SumChip 工具条**：加「配销比」chip = 全部门店配送总和 / 销售总和
- **新建目标 modal**（`page.tsx` TargetForm）：门店板块「门店配送总目标」后加只读「配销比」= `配送总目标/销售总目标`，随两个 input 实时计算
- 总部品类表（出库指标，无销售/配送对）不加
- 表格 `min-w` 加宽（680→约 760）
- 注：录入端只有目标值，配销比即「目标配销比」；达成端配销比达成率见 §6.5

### 4.6 关于共用 TargetRow 组件

两端列表信息结构不同（录入看目标值·表格；报表看达成率·卡片），共用收益低。**本轮不强求**，各自统一到 slate 体系。

---

## 5. Excel 导入 diff 预览（批量修改核对）

现状 `[id]/page.tsx:125-138` `handleImport`：上传 xlsx → 解析 → **直接覆盖**本地 state → toast。痛点：几百店改完无法核对就落本地。

改为「解析 → diff 预览 → 确认才覆盖」：

- 上传 → POST `/api/admin/targets/template` 解析（后端不变，已返回 rows）
- 前端拿 rows 与当前 `branchRows.metrics` 按 `branch_num + metric` 比对，算 diff
- 弹 **diff 预览 modal**：
  - 顶部统计：变更门店数 / 变更格数 / 子和校验结果（导入后子和 vs 总目标）
  - 表格只列**有变更**的行：门店号 / 门店名 / 指标 / 原值 / 新值 / 差额（差额红绿）
  - 未变更行折叠不显示
  - 按钮：`确认覆盖` / `取消`
- 确认 → 合并到本地 `branchRows`（仍未落库，需点「保存全部分解」才入库，与现有流程一致）
- 取消 → 不动

纯前端比对 + modal，后端零改动。modal 复用卡片/slate 样式。

---

## 6. 达成端修复（4 项）

### 6.1 KPI 数字/着色口径

`kpi-cards.tsx:118-123`：数字=达成率、颜色却=达成率/进度（月初失真）。改：颜色=`rateColor(achievement_rate)`，三色阈值与 `target-list.tsx` 一致（≥1 绿 / ≥0.8 琥珀 / <0.8 红）；`progress` 仅作副信息小字，不参与着色。

### 6.2 清理 KPI focus 死代码

`desktop.tsx:80` / `mobile.tsx:81` `focus="sale" onFocus={()=>{}}`：移除 `focus`/`onFocus`/`isFocus` 点击态，`<button>` → `<div>`（卡片非交互）。仅 target dashboard 用 KpiCards（已确认），接口收窄安全。

### 6.3 补 DESIGN 要求的导出/图片/分享

`RegionDrillTable` / `CategorySummary` 外层 div 加 `useRef`，`ChartActions` 传 `onImage=exportImage(ref)` + `onShare=复制本页 URL+toast`。`KpiCards` 不加（数字卡无图形导出价值）。移动端深度推企微留 backlog。

### 6.4 清理死代码

- 删 `web/lib/report-center/achievement.ts`（零引用）
- 删 `web/components/charts/gauge-chart.tsx`（零引用，仅 `loading.tsx:29` JSX 注释提及 → 一并清注释）

删前再 `grep` 确认零 import。

### 6.5 配销比达成率（达成端，前端派生不落库）

口径：配销比达成率 = 实际配销比 / 目标配销比 = `(delivery_actual/sale_actual) / (delivery_target/sale_target)`，数学上等价于「配送达成率 / 销售达成率」。>1 表示配送进度快于销售。

`RegionDrillTable` 加 1 列「配销比」（门店零售/配送表）：
- 主数字：配销比达成率（百分比，如 `112%`）
- 副信息小字：目标配销比 → 实际配销比（如 `40% → 45%`）
- **中性色（不着三色）**：配销比是结构指标，非「越高越好」，避免红绿误导业务判断
- 除零：`sale_target=0` 或 `sale_actual=0` → `—`
- 数据源：region-breakdown 行已有 `sale_target/sale_actual/delivery_target/delivery_actual`，纯前端派生，零后端改动
- 总部品类表（出库指标）不加；KpiCards 不加（派生结构指标，保持 4 主指标卡）
- 表格 `min-w` 加宽（约 +100px）

**不落库**：配销比是 sale/delivery 的确定派生值，落库冗余且需维护一致性；未来要按配销比查询/筛选/排序时再加列。

---

## 7. 前台 sidebar 改造

`web/components/layout/sidebar.tsx`：
- 删「设置」菜单项（剩「报表中心」）
- emoji `📊` → lucide `LayoutDashboard size=18 strokeWidth=1.5`
- 配色 gray → slate（`bg-gray-50→bg-slate-50`、`bg-gray-200→bg-slate-200` 等激活态对齐）
- icon 字段类型 `string`(emoji) → `ReactNode`

---

## 8. 文件改动总清单

**前端 `web/`**：
1. `lib/report-center/metric-source.ts` — label 术语
2. `components/report-center/kpi-cards.tsx` — 着色口径 + 删 focus 死代码
3. `components/report-center/region-drill-table.tsx` — 术语 + 标题 + Excel head 空格 + ▼▶→lucide + ref + ChartActions onImage/onShare + **配销比达成率列**
4. `components/report-center/category-summary.tsx` — Excel head 空格 + ref + ChartActions onImage/onShare
5. `app/reports/targets/[id]/desktop.tsx` — 删 focus 传参
6. `app/reports/targets/[id]/mobile.tsx` — 删 focus 传参
7. `app/reports/targets/[id]/loading.tsx` — 清 GaugeChart 注释
8. `app/admin/targets/page.tsx` — gray→slate + 卡片容器 + 状态徽章 + 术语 + 文案 bug + **新建 modal 配销比只读**
9. `app/admin/targets/[id]/page.tsx` — gray→slate + 卡片容器 + METRIC_NAME 术语 + 边框 slate + **门店表配销比列 + 顶部配销比 chip + Excel 导入 diff 预览 modal**
10. `components/layout/sidebar.tsx` — 删设置项 + emoji→lucide + slate
11. 删 `app/settings/page.tsx`
12. 删 `lib/report-center/achievement.ts`
13. 删 `components/charts/gauge-chart.tsx`

**DB 迁移**：
14. `database/migrations/077_term_governance.sql`（新建）— 同步 `metric_definitions.name` / `metric_registry.name` 术语显示名（幂等 UPDATE）

**文档**：
15. `docs/architecture.md §10.8` — 品类 3 类 + 权威术语表

---

## 9. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 纯 UI/文案/前端交互，无数据接口改动 | 低 | 最坏 `git revert` 回滚 |
| 删死代码/删 settings 破坏 build | 低 | 删前 grep 确认零引用；本地 `next build` 验证 |
| `metric-source.label` 改动波及其他引用 | 低 | 实施时全局 grep `METRICS[` / `metric.label` 确认 |
| 配销比除零 | 低 | 销售=0 显示 `—` |
| Excel diff 比对遗漏 metric | 中 | 按 branch_num × {sale,delivery} 全比对 |
| 术语文案漏改 | 中 | 实施后 grep `门店零售\|月出库` 核对残留 |

部署：纯 `web/` + `docs/`，`git push origin main` → GHA（3-4 分钟）。

---

## 10. 验收标准

- [ ] 录入端配色 slate（无 `gray-` 残留）；表格包卡片容器；分解表全边框保留、边框 `slate-200`
- [ ] 分解表门店行/战区行/区域行有「配销比」只读列，顶部有配销比 chip；新建 modal 有配销比只读
- [ ] Excel 导入弹 diff 预览（变更行/原值/新值/差额/子和校验），确认才覆盖
- [ ] 前台 sidebar 无「设置」项、无 emoji（lucide）；`/settings` 路由删除
- [ ] 状态徽章中文
- [ ] 术语：grep `月出库\|门店零售` 达成端无残留；`出库` 仅 outbound 语境
- [ ] KpiCards 数字=达成率、色=绝对达成率三色、无 focus 点击态
- [ ] RegionDrillTable / CategorySummary 有 Excel/图片/分享三按钮
- [ ] RegionDrillTable 有配销比达成率列（中性色、除零显示 —）；录入端有目标配销比（分解表列 + 顶部 chip + 新建 modal）
- [ ] `achievement.ts` / `gauge-chart.tsx` / `settings/page.tsx` 已删，`next build` 通过
- [ ] Excel 导出表头无前导空格
- [ ] 架构 §10.8 品类 3 类 + 权威术语表已更新

---

## 11. Backlog（本轮不做）

- 录入端移动适配
- 录入交互重构：`confirm()`→自定义弹窗、手动结案/复制/删除、子和校验信息去冗余、输入性能（keyed 索引 / useMemo）
- 批量修改其余方案：UI 按规则调整（比例缩放/固定值/配销比反推）、智能分摊（历史占比）
- KPI focus 接真实指标维度切换
- 移动端深度分享（推企微会话，接 wecom-notify）
- 录入范围对齐考核战区（`is_assessed_war_zone`）
- 目标达成企微日报推送
- `import/route.ts` 疑似未调用，待确认清理
- admin layout 外壳整体配色统一
- 前端 `metric-source.label` 运行时引用 `metric_registry`（术语单一事实源；需 client/server 数据流重构 + 两套 metric_code 映射 sale↔sale_amount）

---

## 12. 移动端策略（说明）

移动端是用户最高频看数据的场景，但当前 spec 不含移动端重设计（已与用户确认拆为独立子项目 B，当前 spec 先落地）。

- **共享组件改动移动端继承**：当前 spec 改 `RegionDrillTable`（术语/配销比列/ChartActions）、`KpiCards`（口径/删 focus）、`CategorySummary`（ChartActions）等共享组件，PC 直接受益；移动端（`mobile.tsx` 复用同一组件）临时继承——横滚交叉表体验差的根因留待子项目 B 解决。
- **mobile.tsx 本轮只做最小必要**：删 focus 死代码（§6.2），不做卡片化/排行/sparkline 重设计。
- **子项目 B（移动端报表展示重设计）**：新建 `components/report-center/mobile/` 专用组件（KPI 卡片流、门店排行卡、趋势 sparkline、我的店卡片、品类概览），数据层复用 `lib/report-center/*`，`mobile.tsx` 改为组装移动专用组件。下一个 brainstorm + spec。
