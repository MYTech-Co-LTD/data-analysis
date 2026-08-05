# 前端渲染层数据准确性守护设计（F1–F7）

日期：2026-08-05
状态：brainstorming design 已分段获批，待 commit
上位规划：`docs/superpowers/specs/2026-08-05-data-accuracy-guard-overall-design.md`（子系统④）
范围：F1/F2（P0）详细设计；F3–F7（P1/P2）给框架要点，不展开实现

## Context

前端渲染层是全链路守护体系（上位规划§一）的最后一环，也是基线 spec `2026-08-03` **完全没覆盖**的环节——其检查链「视图 ─C3─ 前端」中的 C3 实为 PG 侧 `_audit`，前端层当前**零运行时守护**。

实测静默风险（最高）：
- **RLS 裁剪 / can_see_cost 脱敏前端无感**：店长账号看到的「全战区/品牌合计」行实际只 SUM 了其有权门店子集，标签仍叫全量 → 店长把被裁合计误读为全量做决策（业务事故级）；profit 脱敏返 NULL 被 `Number(x||0)` 当 0 累加（TOP 商品毛利合计被压成 0）。
- **6/7 getter 吞错返 `[]`**：查询失败被当"无数据"渲染；`Promise.all` 单模块失败=整页挂、部分失败=伪装 200。
- 合计行丢弃不校验、无异常值检测、无时效陈旧门、qa_logs 前端 write-only、0 报表 E2E 断言。

目标：让用户**能信任看到的数据**——查询失败不伪装、被裁/脱敏/陈旧/异常显式标注、合计错不错得出。

## F1 取数错误透传 + 部分降级（P0）

目标：查询失败不再伪装成"无数据"；整页不再因单模块失败而挂；用户能区分"无数据 / 加载失败"。

1. **getter 返回结构统一**：`web/lib/report-center/*.ts` 7 个 getter 返回 `{rows, status, error?}`，`status ∈ {ok, no-data, error}`。失败时**不再 `return []`**，返 `status=error` + 错误信息。复用 `web/lib/error.ts` `wrapError`。
2. **page.tsx 取数容错**：`web/app/reports/targets/[id]/page.tsx` 的 `Promise.all` → `Promise.allSettled`（各 getter 内部 catch 返 error 结构，整页不再因单模块挂）。KPI 模块（`getTargetKpi`，原 throw 致整页 error.tsx）改为同样返 error 结构。
3. **模块级降级渲染**：每个 `web/components/report-center/*` 模块组件接收 `status/error`，`error` 时显示"本模块加载失败 + 重试"按钮，而非空白"暂无数据"。
4. **部分降级横幅**：page 顶部统计「N/7 模块加载失败」+ "重试全部"。
5. **报表页 error boundary**：新增 `web/app/reports/targets/[id]/error.tsx`（模块级），捕获未预期错误时保留报表上下文（全局 `app/error.tsx` 丢上下文）。

## F2 RLS / 脱敏可见性标注（P0，路径①：前端读权限）

目标：让用户知道"合计是按权限裁剪的、非全量"、"profit 列被脱敏了"，不再把被裁合计误读为全量。

**实现路径决策**：选①前端读权限（纯前端、零后端改动、立即见效）。否决②视图增 is_filtered 列（改生成器=架构变更、逐行精确是 YAGNI 过度设计）、③混合。

1. **权限信息获取**：前端拿当前用户的 `branch_nums`（是否限门店）与 `can_see_cost`。**优先复用现有用户信息 route**（如已有 `/api/me`/`getUserInfo`）；**否则新建 `/api/me`**，后端解码 JWT 返回 `{branch_nums, can_see_cost}`（权威统一，不在前端散落 token 解析）。全权用户（branch_nums 空/`*`、can_see_cost=true）→ 不标注。
2. **RLS 裁剪标注**：`branch_nums` 非空（限门店用户，如店长）→ 报表页顶部一次性横幅：**"数据已按你的门店权限裁剪——'合计/战区/品牌'行仅含有权门店，非全量"**。
3. **can_see_cost 脱敏标注**：`can_see_cost=false` → profit/margin 列：列头加角标 + tooltip"已脱敏"；单元格显示"—"（**不显示 0**）。
4. **修 bug**：`web/lib/report-center/item-breakdown.ts` `toBoard` 对脱敏 profit `Number(r[profitKey]||0)` 当 0 累加进 `totalProfit`（TOP 商品毛利合计被压成 0）→ 改为脱敏时不累加 profit、合计显示"—"。
5. **标注形态**（对齐 DESIGN.md）：RLS=顶部横幅（全局性质）；脱敏=列头角标+tooltip（每列）。复用 `data_status` 徽章同位视觉语言。

## F3–F7 框架要点（P1/P2，不展开实现）

| 代号 | 守护 | 框架要点 | 复用 |
|---|---|---|---|
| F3 合计自洽 | 前端重算合计 vs 视图合计行，不一致→"合计异常"角标（不阻断）。推广自算 totals 模式到 brand/region/supply-chain | `category-summary.ts` |
| F4 异常值检测 | 负值/比率>1.5或<0/NaN→单元格标红+"可疑" | `rateColor`/`marginColor` |
| F5 时效陈旧门 | freshness 距今>阈值(如6h)→顶部横幅标红"数据停留在 X"；RPC 失败显示"获取失败"非"—" | `get_data_freshness` |
| F6 QA前端可见 | `data_status` 从 KPI 4 指标扩到全模块；新增 qa_logs 只读摘要（最近失败项） | data_status/qa_logs |
| F7 E2E数据断言 | Playwright 报表页用例：关键 KPI 非空非负、合计行存在、模块不报错 | 现有 4 smoke |

## 关键文件
- `web/lib/report-center/*.ts`（7 getter 返回结构改造、`item-breakdown.ts` toBoard 修复）
- `web/app/reports/targets/[id]/page.tsx`（Promise.allSettled + 部分降级横幅 + RLS 横幅）
- `web/app/reports/targets/[id]/error.tsx`（新增模块级 error boundary）
- `web/components/report-center/*`（模块降级渲染、脱敏列头角标）
- `web/lib/api.ts` 或新建 `/api/me` route（权限获取）
- `web/lib/error.ts`（复用 wrapError）

## 验证
- F1：手动让某 getter 抛错（如改视图名临时失效）→ 确认该模块显示"加载失败+重试"、整页不挂、顶部"N/7失败"横幅。
- F2：用店长账号（branch_nums 非空）登录 → 确认 RLS 横幅显示；用 can_see_cost=false 账号 → 确认 profit 列"—"+角标、TOP 毛利合计不再被压 0。
- F3–F7 各自落地后单独验证（制造合计错/异常值/陈旧数据看标注）。

## 架构文档更新
- 新增 §10.12「前端渲染层守护（F1–F7）」——本 spec 入档。
- 标注：F2 走前端读权限路径（不改视图/生成器，非架构变更）；若未来升级到 is_filtered 列则需架构变更。
