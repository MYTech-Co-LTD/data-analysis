# 报表中心配销比 / 毛利率 KPI 卡 + 下钻表比率 + 看板并排高度耦合 设计

- 日期：2026-08-08
- 范围：纯前端（`web/`）+ `DESIGN.md`。无数据库迁移、无生成器改动、无 view-config 改动、不重启 postgrest。
- 方案：**F — 前端除法**（比率 = 两个语义层已聚合分量之商，逐行相除 = ratio-of-sums）。

---

## 1. 目标与范围

报表中心目标详情页新增/增强 4 个呈现面：

| # | 呈现面 | 位置 | 内容 |
|---|---|---|---|
| 1 | 配销比 KPI 卡 | 顶部 KPI 区（4 张金额卡之后） | 现状卡：大号=配销比，下方=配送/销售金额。**无目标、无三色**。 |
| 2 | 毛利率 KPI 卡 | 顶部 KPI 区（配销比卡之后） | 大号=出库毛利率，套**绝对三色**（vs 12%）。下方=毛利/出库金额 + "目标 12%"。 |
| 3 | 品牌看板配销比列 | 品牌×指标表 | 新增"配销比"列，纯文本（无三色）。 |
| 4 | 区域报表配销比三色 | 门店零售/配送数据报表 | "配销比"列改**绝对三色**（vs 该行配销比目标）；"配销比目标"列保持纯文本。 |
| 5 | 看板并排高度耦合 | 供应链出库 + 外部批发客户出库（桌面并排） | 供应链表下钻撑开（高度权威）；外部批发表填满其高度、超出内部滚动（header 吸顶）。移动端不变。 |

口径：
- **配销比 = 门店配送 / 门店销售**。`delivery` 口径 = distribution（含品品甜 64188 批发附加），与现有"配送"卡同源。
- **毛利率 = 出库毛利 / 出库金额**（`outbound_profit / outbound_amt`，出库口径含外部批发，品类限水果/标品/耗材）。12% 为全局业务阈值（前端常量）。

## 2. 为什么是前端除法（F），不是语义层视图（S）

决策已评估两案，选 F：

- **数值等价**：配销比/毛利率都是两个**已聚合分量**之商。前端拿到的 `delivery_actual`、`sale_actual`、`outbound_profit`、`outbound_amt` 已是各粒度 SUM 后的值，逐行相除 = SUM(分子)/SUM(分母) = ratio-of-sums，与生成器在视图里算出的结果**完全相同**。"比率之和≠和之比"仅在跨行累加比率时出现，F 与 S 都不这么做。
- **口径已在语义层**：`delivery_sale_ratio`、`outbound_margin` 均已在 `metric_registry` 注册（含 AST）。口径定义层已就位，F 无需重复定义。
- **改动小一个量级**：F 改 4 个前端文件；S 需改 3 个 view-config + 连库重生成 + 新 getter + 触 DB 部署 + restart postgrest，且 `outbound_margin` 在品牌/区域粒度会因 `branch_num<>'99'` 过滤退化（丢失外部批发）。
- **既有范式**：`web/lib/report-center/ratio.ts` 注释明定"配销比 = 配送/销售，派生值，不落库"；区域钻取表已用其算配销比。F 沿用此范式，非新创 hack。
- **何时再升格到 S**：将来若有 SQL 层消费者（其它 API/导出/BI）需直接查比率列时，再把已注册的指标挂进 view-configs（指标已注册，挂载成本低）。

## 3. closed 目标的快照兼容性（F 成立的关键）

close_target（migration 162）对 total 与三个 breakdown 模块都用 `SELECT * FROM <视图> WHERE target_id=%L` 冻结——视图输出什么就冻什么。因此所有分量都进快照，F 的比率 = 两个冻结分量之商，定格时刻确定性保留：

| 比率 | 面 | 分子（快照来源） | 分母 | 结论 |
|---|---|---|---|---|
| 毛利率 | KPI total | `outbound_profit` 真值（migration 160：close 时强制 `can_see_cost=true`，非 NULL） | `outbound_amt` | ✅ |
| 配销比 | KPI total | `delivery` | `sale` | ✅ |
| 配销比 | 品牌 | `delivery_amount` | `sale_amount` | ✅（SELECT *） |
| 配销比+目标 | 区域（大区/小区/门店） | `delivery_actual` / `delivery_target` | `sale_actual` / `sale_target` | ✅ 三级全冻 |

生产证据：区域钻取表现在就用 `ratio.ts`（F 式）算配销比，且 closed 目标正常显示——证明快照确实冻了 `sale_actual/delivery_actual`。需补冻结的分量：**无**。

前提（非缺陷）：
1. 目标须在 migration 162 部署后 close（159–162 依次修了"只冻 sale""profit NULL""breakdowns 丢失"）。旧目标重固化幂等：`UPDATE targets SET status='active'; SELECT close_target(id);`。
2. close 只对 `total` 级目标冻 breakdowns（与现网一致，看板只按 total 目标渲染）。

## 4. 改动清单

### 4.1 `web/lib/report-center/ratio.ts`（扩展纯函数）
- 新增 `marginAchievement(margin: number | null, target = 0.12): number | null` = `margin / target`（毛利率对 12% 的达成率；margin 为 null → null）。
- 新增 `absoluteThreeColor(rate: number | null): string`：`>=1 → 'text-green-600'` / `>=0.8 → 'text-amber-600'` / `<0.8 → 'text-red-600'` / `null → 'text-slate-300'`。**绝对**达成率三色（不除时间进度），本次两个比率对比共用。
- 毛利率值复用现有 `actualRatio(num, den)`（已是通用 num/den），不新增。
- 保留现有 `actualRatio` / `targetRatio` / `ratioAchievement` / `formatRatio`。

### 4.2 `web/components/report-center/kpi-cards.tsx`（加 2 张比率卡）
- 数据**复用现有 `typedRows`**（`getTargetKpi` 已一次取回 sale/delivery/outbound_amt/outbound_profit 四行 total 级数据），**无需新查询**。按 `metric_code` 查出对应行。
- 在 `METRIC_ORDER.map(...)` 之后追加 2 张比率卡，复用同一卡片外壳（`rounded-md border p-4`）。
- 比率卡配置化：
  - `总配销比`：`num='delivery'` `den='sale'` `colored=false`
  - `毛利率`：`num='outbound_profit'` `den='outbound_amt'` `colored=true` `target=0.12`
- 渲染：
  - 大号数字 = 比率值 `(ratio*100).toFixed(1)%`（如 85.3% / 18.5%）；null → `—`。
  - 副行 = `配送{fmtWan} / 销售{fmtWan}` 或 `毛利{fmtWan} / 出库{fmtWan}`；金额 null（脱敏）→ `—`。毛利率副行末尾加小字 `· 目标 12%`。
  - 毛利率大号套 `absoluteThreeColor(marginAchievement(ratio, 0.12))`；配销比默认 `text-slate-800`。
  - 守卫：`isSuspiciousMargin(ratio)` → 大号 `text-red-600` + `<SuspiciousBadge>`（同现有卡）。
- 比率卡**不放 data_status 徽章**（派生值，数据状态看 4 张源卡）、**不放 KpiTooltip**（副行已展示分子分母；移动端本就隐藏 tooltip）。
- 布局沿用 `grid-cols-2 md:grid-cols-4`：md 下 4 张金额卡 + 2 张比率卡（第二行左两格）；移动端 2 列自动换行。
- `fmtWan` 需 null-safe（现仅接 `number`）：比率卡副行用 `v==null ? '—' : fmtWan(v)` 包装。

### 4.3 `web/components/report-center/brand-metric-table.tsx`（加配销比列）
- 表头在"配送金额"后插 `<th>配销比</th>`；单元格 `formatRatio(actualRatio(r.delivery_amount, r.sale_amount))`（沿用 `toFixed(0)%`，与该表既有比率列一致）。
- 颜色纯文本 `text-slate-700` + `suspiciousClass(isSuspiciousMargin(...), ...)`。
- 合计行用合计行自身的 `delivery_amount/sale_amount`（视图合计=总和，正确 ratio-of-sums）。
- `colSpan` 7→8（空态）；Excel 导出 head/body 同步加"配销比"列。
- frontTotals 自洽校验（F3）增配销比项：`SUM(delivery)/SUM(sale)` vs 合计行比率，延续现有守护。

### 4.4 `web/components/report-center/region-drill-table.tsx`（配销比列上三色）
- 桌面"配销比"列（actual，现 `text-slate-700`）：改套 `absoluteThreeColor(ratioAchievement(d.delivery_actual, d.sale_actual, d.delivery_target, d.sale_target))`；外层保留 `suspiciousClass(isSuspiciousMargin(actualRatio(...)), ...)`。
- "配销比目标"列保持纯文本 `text-slate-400`，不上色。
- 移动端抽屉 `buildRegionFields` 的"配销比"字段同步上色。
- 导入 `absoluteThreeColor`（来自 `ratio.ts`）。注意：本文件已有 `rateColor(rate, progress)` 是**相对进度**三色，不可复用于此；比率对比用**绝对** `absoluteThreeColor`。
- Excel 导出不变（两列已导出）。

### 4.5 `DESIGN.md`（记录新规则）
"报表中心特定约定"增两条：
- 毛利率 KPI 卡（出库毛利率 vs 12%）：绝对三色 `>=12% 绿 / 9.6–11.9% 琥珀 / <9.6% 红`。
- 配销比报表列（vs 行配销比目标）：绝对三色 `ratioAchievement >=1 绿 / >=0.8 琥珀 / <0.8 红`。
- 保留第 71 行"门店行毛利率二元 <12% 标红"规则（表格行，不冲突）。

### 4.6 测试
`ratio.ts` 新纯函数加单元测试：`marginAchievement`、`absoluteThreeColor`。覆盖：null、负毛利（如 −5% → 达成率 <0.8 → 红）、分母 0、阈值边界（0.79/0.8/0.99/1.0/1.2）。按 `docs/testing-handbook.md` 选层。

## 5. 边界与守卫

- 分母为 0（sale=0 / outbound_amt=0）→ 比率 null → `—`（灰）。
- `outbound_profit` 脱敏 null（`can_see_cost=false`）→ 毛利率 null → `—`（灰）；副行 `毛利— / 出库X`。
- 比率越界（>1.5 或 <−1）→ `isSuspiciousMargin` → 标红 + SuspiciousBadge。
- 负毛利（亏损，如 −5%）→ `marginAchievement` 为负 → `absoluteThreeColor` 判 `<0.8` → 红（语义正确：亏损=差）。
- 金额脱敏与现有 `outbound_profit` 卡行为一致（无成本权限者看 "—"）。

## 6. 部署

纯 `web/` + `DESIGN.md` 改动 → `git push origin main` 触发 GHA 完整部署。**无 function/迁移/生成器改动**，不直调 SSH、不重启 postgrest。

## 7. 不做（YAGNI）

- 不把比率挂进语义层 view-configs（指标已注册，将来有 SQL 层消费者时再升格）。
- 毛利率不进品牌/区域下钻表（仅 KPI 卡；下钻粒度 outbound_margin 会退化）。
- 不加比率卡的趋势图/下钻。
- 不动 achievement 视图、`target_metric_values`、`metric_definitions`、`generators/*.ts`。

## 8. 看板并排高度耦合（追加需求）

桌面端「供应链出库数据报表」（`SupplyChainOutboundTable`）与「外部批发客户出库报表」（`WholesaleDailyTable`）已在 `desktop.tsx` 并排（`grid grid-cols-1 gap-4 md:grid-cols-2`，第 132–146 行）。需求：**供应链表下钻时撑开、自然增长（高度权威）；外部批发表填满供应链当前高度、内容超出则内部滚动（表头吸顶）**。移动端不变（各自堆叠、自然高度）。

### 8.1 改动

**`web/components/report-center/supply-chain-outbound-table.tsx`（桌面表格容器）**
- 第 335 行 `className="max-h-[28rem] overflow-auto"` → `className="overflow-x-auto"`。
- 去掉 448px 纵向限高，下钻展开时表格自然撑开（驱动并排行高）；保留横向滚动（7 列在半宽可能溢出）。
- sticky `thead` 在无纵向滚动容器下退化为普通表头（可接受，因表格随页滚动）。

**`web/app/reports/targets/[id]/desktop.tsx`（外部批发用绝对定位填满 + 滚动）**
```tsx
{/* 供应链出库层级 + 外部批发日报（2 看板并排；供应链高度权威，批发随高滚动） */}
<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
  <SupplyChainOutboundTable ... />
  <div className="md:relative">
    <div className="md:absolute md:inset-0 md:overflow-y-auto">
      <WholesaleDailyTable ... />
    </div>
  </div>
</div>
```
- 原理：grid 默认 `items-stretch` → 行高由供应链（有内容）决定；外部批发 wrapper（`md:relative`，其 `absolute` 子元素不计入高度）被 stretch 撑到行高；内层 `md:absolute md:inset-0 md:overflow-y-auto` 填满该高度并纵向滚动。供应链下钻引起高度变化时 grid 自动重算，**无需 JS**。
- `md:` 前缀确保移动端（`grid-cols-1`）不生效：wrapper 与内层退化为普通流式，批发表自然堆叠。
- `WholesaleDailyTable` 的 `thead` 已 `sticky top-0`，在 `overflow-y-auto` 容器内吸顶（滚动时表头可见）。

**`web/app/reports/targets/[id]/mobile.tsx`**：不变（两表各自 `px-4` 堆叠，无高度耦合）。

### 8.2 权衡与退路

- 权衡：供应链折叠（仅大区行）时较矮，外部批发滚动视口相应较小、需多滚；供应链全展开（所有门店）时页面变长。此为「供应链为主」设计的既定取舍。
- 退路：若 CSS 绝对定位在 html2canvas 导出图片或个别浏览器表现异常，改用 `ResizeObserver` 测量供应链卡片高度、设外部批发 `maxHeight` + `overflow-y-auto`（JS 方案，等价效果）。

### 8.3 不做（YAGNI）

- 不把高度耦合套到移动端（窄屏堆叠更可读）。
- 不给供应链表设最低高度（避免空撑）。
