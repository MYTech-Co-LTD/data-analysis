# Design System — 数据分析平台

> 所有视觉/UI 决策先读此文件。字体/色彩/间距/美学方向在此定义，未经用户同意不要偏离。QA 模式下，不符合 DESIGN.md 的代码要标记。

## Product Context
- **是什么**：零售数据分析平台（2 品牌：3120 熊喵鲜生 / 64188 品品甜），把销售/配送/批发/目标达成数据呈现给业务用户
- **给谁**：老板/运营总（看全公司大盘）、店长（看本店）、业务/采购（看品类/客户）
- **空间**：零售 + 数据分析/BI（对标 Tableau/PowerBI/观远/FineBI）
- **类型**：web app / BI dashboard，PC 为主 + 企微内移动适配
- **记忆点**：**专业经营分析**——克制、数据密集、可信，像 BI 工具不像花哨 SaaS

## Aesthetic Direction
- **方向**：Industrial/Utilitarian（功能优先、数据密集、克制）
- **装饰**：minimal——数据为主，无装饰噪音（无紫色渐变、无装饰 blob、无居中堆叠）
- **调性**：Tableau/PowerBI 同源的专业经营分析感
- **参考**：Tableau、PowerBI、观远 BI、FineBI

## Typography
- **Display/Hero**：DM Sans 700（现代专业、开源，避开过用的 Inter/Roboto）
- **Body**：DM Sans 400/500
- **UI/Labels**：DM Sans 500（同 body）
- **Data/Tables**：DM Sans + `font-variant-numeric: tabular-nums`（**报表数字对齐必需**）
- **Code**：JetBrains Mono（如需）
- **加载**：Google Fonts CDN `<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap">`
- **Scale**：12(sm)/14(body)/16(lg)/18/20/24/30/40（rem 对应 0.75/0.875/1/1.125/1.25/1.5/1.875/2.5）

## Color
- **策略**：balanced（主色 + 中性 + 语义色，色彩稀有且有意义）
- **Primary**：`#1E40AF`（深蓝，专业/信任，CTA/链接/重点）
- **Neutrals**（cool slate）：bg `#F8FAFC` / surface `#FFFFFF` / border `#E2E8F0` / muted `#64748B` / faint `#94A3B8` / text `#0F172A`
- **Semantic**：success `#16A34A`（达成>进度）/ warning `#D97706`（接近）/ error `#DC2626`（落后）/ info `#1E40AF`
- **数据可视化**：色盲安全板。达成率三色编码（绿/琥珀/红）；多系列趋势用 primary 蓝 + 蓝色梯度（#1E40AF→#60A5FA）+ 灰
- **Dark mode**：primary 亮一档 `#3B82F6`，bg `#0F172A`，surface `#1E293B`，border `#334155`，text `#F1F5F9`，语义色饱和度降 15%

## Spacing
- **base**：8px
- **密度**：comfortable（信息密度高但有序呼吸）
- **Scale**：2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **策略**：grid-disciplined（严格网格，报表对齐）
- **网格**：PC 12 列；移动单列卡片流
- **内容宽**：看板 full width 屏幕自适应（p-6 边距，长表 overflow-x-auto/max-h 滚动）；管理后台 full width
- **圆角**：sm 4px（输入/小元素）/ md 8px（卡片/按钮）/ lg 12px（看板容器）/ full 9999px（标签/徽章）

## Icon
- **库**：lucide-react（项目已装，shadcn 配套）。**禁 emoji**（🎯📊🏠🚚📦⬇🖼🔗 这种 AI 味重、不专业、各平台渲染不一致、无障碍差）
- **尺寸**：sm 16px / md 20px / lg 24px，stroke-width 1.5（轻量专业，不用 2+ 粗描边）
- **颜色**：`currentColor`（继承文本色）；语义场景配语义色（成功 Check=success / 警告 AlertTriangle=warning / 错误 XCircle=error）
- **语义映射**（常用，统一用这套，不混）：
  - 目标/达成 = `Target`（或 `Trophy`）
  - 仪表盘 = `LayoutDashboard`；门店 = `Store`；商品 = `Package`；配送 = `Truck`；批发 = `ShoppingCart`
  - 趋势 = `TrendingUp`；排行 = `BarChart3`；Top = `Crown`（克制，不用 `Flame`）
  - 导出 Excel = `Download`；图片 = `Image`；PDF = `FileText`；分享 = `Share2`
  - 查询/搜索 = `Search`；新建 = `Plus`；编辑 = `Pencil`；删除 = `Trash2`
  - 确认 = `Check`；关闭 = `X`；下拉/切换 = `ChevronDown`；返回 = `ArrowLeft`；战区/区域 = `MapPin`
- **对齐**：图标与文本基线对齐；按钮内 图标 16px + 文字 gap 6px；表头图标 16px + 标题
- **不用**：emoji、彩色填充图标、Material Icons、混用多套图标库

## Motion
- **策略**：minimal-functional（只过渡辅助理解，不花哨）
- **Easing**：enter ease-out / exit ease-in / move ease-in-out
- **Duration**：micro 50-100ms（hover）/ short 150-250ms（展开/切换）/ medium 250-400ms（页面/弹窗）

## 报表中心特定约定
- **达成率三色编码（默认）**：按绝对达成率 -- 绿(≥100%) / 琥珀(80-99%) / 红(<80%)；progress（时间进度）仅作副信息文本，不参与着色。零售达成特色。
- **达成率三色编码（战区下钻表特例）**：rate < progress（落后时间进度）即红，其余按绝对值（≥1绿/≥0.8琥珀/<0.8红）。
- **看板三段式**：KPI 大数字卡 -> 图表（趋势/排行）-> 类 Excel 交叉表 + 明细下钻
- **类 Excel 交叉表**：tabular-nums + 维度切换（行/列各一维）+ 点单元格下钻 + 战区/二级区域合并单元格
- **KPI 卡**：达成率大数字直接套三色编码（绿/琥珀/红，同上规则），progress 作副信息小字标注。
- **毛利率标红（二元）**：配送/出库门店行毛利率 <12% 标红；批发毛利率 <0（负毛利）标红。无琥珀过渡档。
- **毛利率 KPI 卡（出库毛利率 vs 12%）**：绝对达成率三色 `≥12% 绿 / 9.6–11.9% 琥珀 / <9.6% 红`（脱敏 NULL 灰）。比率对比固定阈值，不除时间进度。
- **配销比报表列（vs 行配销比目标）**：绝对达成率三色 `ratioAchievement(实际/目标) ≥1 绿 / ≥0.8 琥珀 / <0.8 红`。
- **每组件操作**：图表/交叉表右上角 ⬇Excel/🖼图片/🔗分享（组件级，非全页）
- **导出**：Excel（xlsx 数据）/ 图片（html2canvas）/ PDF（PC）；移动端只"生成分享图"（卡片图转企微）

## Decisions Log
| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-07-12 | 初始设计系统 | /design-consultation 基于产品上下文 + 记忆点"专业经营分析" + 零售 BI 竞品研究（Tableau/PowerBI） |
| 2026-08-02 | 三色编码+KPI卡以实际代码为准 | 审查发现文档与实现不符；用户定改文档不改代码，避免无谓返工 |
| 2026-08-02 | 看板宽度改 full width 屏幕自适应 | 原 1100px 居中致宽屏留白变小；用户要屏幕自适应，去 max-w cap 保留 p-6 边距 |
