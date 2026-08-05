# 全链路数据准确性守护总体规划

日期：2026-08-05
状态：brainstorming design 已分段获批，待 commit；本 spec 为分解蓝图，各子系统后续单独 spec→plan→实施
基线 spec：`docs/superpowers/specs/2026-08-03-data-accuracy-semantic-layer-design.md`

## Context

平台数据链路：`乐檬源API → 采集(transform) → parquet明细 → compute聚合(report_daily_*) → 语义层视图(report_*_gen) → 前端报表`。任一环静默出错（漏采/翻倍/丢品牌/口径漂移/RLS裁剪/脱敏）都会让报表数据错而无人知。

基线 spec `2026-08-03` 已设计 C0–C5/D1–D2 全链路守护框架，但**落地残缺**：C1/C3/C4/自动修复/gen-views 触发缺失；**前端渲染层 spec 完全没覆盖、当前零守护**。本规划对照基线盘点全链路每一环的「设计/落地/缺口」，给出补齐方案与优先级，目标是形成闭环——让静默出错在某一环被发现 + 告警/修复。

本 spec 不展开各子系统实现细节，只给「现状/缺口/方案要点/优先级」。每个子系统后续单独 brainstorm→spec→plan→实施。

## 一、子系统分解与边界

| 子系统 | 链路段 | 守护目标 | 主要守护 |
|---|---|---|---|
| ① 采集层 | 源API → parquet | 明细**完整、不重** | C0 双向 / 采集五铁律 / 自动backfill / D1 |
| ② compute 层 | parquet → 聚合表 | 聚合**准确** | C1 明细↔聚合 / D2 PK / 自动重算 |
| ③ 视图层 | 聚合 → report_*_gen | 视图口径**正确** | C2 视图↔聚合 / C3 rollup / C4 回归 |
| ④ 前端渲染层 | 视图 → 报表 | 用户**能信任看到的数据** | F1–F7（新） |

依赖：①→②→③→④ 单向，上游错下游难纠；但下游必须**能感知上游的错**（前端层把"数据可疑/被裁/陈旧"显式告诉用户，而非默默渲染）。每层既防本层出错，也兜上层漏过的错。

## 二、两大对偶风险维度（横切）

准确性有两类**相反**风险，必须并列守护：

| 环节 | A：漏采/缺漏（少了） | B：重复/过大（多了/翻倍） |
|---|---|---|
| 源→明细 | C0 缺漏向 + 铁律①②③ | C0 疑重向 + **D1 主键唯一** + transform/merge 去重 |
| 明细→聚合 | C1 | D2 + /compute DELETE-before-INSERT |
| 聚合→视图 | C2（丢行/丢品牌） | C2 + 严格 all.parquet glob |
| 自动修复 | C0→backfill / C1→重算 | **D1→重采覆盖（不删）** |

**铁律**：C1/C2 对"同源翻倍"是盲的（明细和聚合/视图同时翻倍，对账相等 PASS）→ **D1 不可替代**（lemeng 分页 id 重生成致 60–120x 重复的实测教训）。

## 三、各子系统 现状 / 缺口 / 方案

### ① 采集层
- **现状**：C0 已落地（每日09:15双向、ε=0）；D1 去重即时守卫；铁律⑤告警；scheduler 02:00 对账近3天；collect-backfill 手动。
- **缺口**：采集后不跑 C0（仅 D1+D2）；C0 缺漏未自动 backfill；铁律③ 写入失败未纳入 `verified`；铁律② 页失败 `page++` 丢页；铁律④ parquet 无软删除（模型限制·已知边界）。
- **方案要点**：采集后即时跑受影响源 C0；C0 missing→自动 backfill ≤3次；D1 dupRatio>1→自动 full 重采该日该源覆盖 ≤3次（不删，比自动删安全）；`verified` 纳入写入失败；页失败重试该页。

### ② compute 层
- **现状**：triggerCompute 采集后自动算 8 表；D2 PK 重复检查；两套 C1（reconcile-check.js 主机cron完整按品牌×日 / scheduler 09:07 简化版只昨天不拆品牌）。
- **缺口**：C1 两套重叠都没进 qa_logs、都没自动重算；reconcile-check.js 硬编码未配置化；item 级行数对账未做。
- **方案要点**：C1 收口进 `detail-sources` 配置 + qa-runner + qa_logs（删硬编码）；C1 diff→自动 /compute 重算 ≤3次；补 item 级行数对账。

### ③ 视图层
- **现状**：L1 validate ✅ / L2 EXPLAIN ✅ / C4 契约测试有；C2 **只 1 条**断言。
- **缺口**：C2 9视图几乎裸奔；C3 `_audit` 被迁移155删；C4 不跑、gen-views 后不触发；achievement_gen 独立生成器不产 `_qa`。
- **方案要点**：C2 扩展（纯配置加断言，brand_metric/region/supply_chain/wholesale，第一版避开成本敏感列）；C3 恢复 rollup 自洽检查；C4 接入 + gen-views 后触发；achievement 产 `_qa`（⚠️ 改生成器=架构变更，单独确认）。

### ④ 前端渲染层（spec 缺口·全新）
- **现状**：data_status 徽章（仅 KPI 4指标）、get_data_freshness（只展示不判断陈旧）、全局 error.tsx、导出=渲染同源。
- **缺口（零运行时守护）**：6/7 getter 吞错返 `[]`；**RLS 裁剪/can_see_cost 脱敏前端无感**（店长看被裁"合计"当全量、profit NULL 被当0累加）；合计行丢弃不校验；无异常值检测；无时效陈旧门；qa_logs 前端 write-only；0 报表 E2E。
- **方案要点（F1–F7）**：F1 取数错误透传+部分降级UI；F2 RLS/脱敏可见性标注；F3 合计自洽校验；F4 异常值检测；F5 时效陈旧门；F6 QA结果前端可见（data_status 扩全模块+qa_logs只读页）；F7 E2E 数据断言。

## 四、优先级矩阵

排序依据：对业务决策的静默误导风险为主，兼顾数据正确性命脉。

| 优先级 | 工作项 | 子系统 |
|---|---|---|
| **P0** | F2 RLS/脱敏可见性 | ④ |
| **P0** | F1 取数错误透传 | ④ |
| **P0** | C1 自动 /compute 重算 | ② |
| **P0** | C2 扩展核心断言 | ③ |
| **P0** | D1→重采覆盖（重复自动修复） | ① |
| P1 | C1 配置化收口+qa_logs / C3 rollup恢复 / C0采集后跑+自动backfill / F5时效门+F6 QA可见 / gen-views后触发C2/C3/C4 | ①②③④ |
| P2 | F3合计自洽 / F4异常值 / F7 E2E / C4回归 / achievement产_qa / 铁律②③强化 / item行数对账 | ①②③④ |

## 五、修复策略（沿用基线 spec 分级 + 重复方向新增）

| 级别 | 检查 | 动作 |
|---|---|---|
| 自动修复 | C0 缺漏 | 自动 backfill ≤3次 |
| 自动修复 | C1 差异 | 自动 /compute 重算 ≤3次 |
| 自动修复（新） | D1 重复 | 自动 full 重采该日该源覆盖 ≤3次（不删，告警留痕） |
| 只告警 | D2/C2/C3 | 不自动改，人工确认后处理 |
| 阻断 | C4 | 部署时契约测试红即停 |

## 六、第一个深入：前端渲染层（④）

理由：① spec 完全缺口（①②③ 多是落地问题，④ 需全新设计）；② 最高静默风险（F2 业务事故级，且是"正常裁剪被误读为全量"，非数据错，独立存在）；③ 用户明确点名。

下一步：启动「前端渲染层」单独 brainstorm（F1–F7 的 design → 前端层 spec → writing-plans → 实施）→ 完成后按优先级逐个推进 compute/视图/采集层。

## 七、架构文档更新（随实施同步）
- §10.10 L4 段：补「文档 vs 实现偏差」修正（C1/C3/C4 落地状态、gen-views 触发）。
- 新增 §10.12「前端渲染层守护（F1–F7）」——spec 未覆盖环节入档。
- 标注架构变更点：achievement_gen 产_qa（改生成器）、F2 视图增 is_filtered 列。

## 八、验证（每个守护落地后）
- 故意制造对应错误（漏采/翻倍/RLS裁剪/合计错），确认该环节告警/修复。
- C0/C1/C2/D1/D2：`npx tsx scripts/qa-run.ts --check=<name>`，qa_logs 有记录。
- 前端 F1–F7：Playwright E2E + 手动制造空/错/裁剪数据看 UI 提示。
- 端到端：改 metric_registry AST → gen-views → 确认 C2/C3/C4 自动跑且 qa_logs 反映回归。
