# 语义层反自由发挥：AST 化 + 机制约束（L1+L2+L3 全配）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。本 plan 是架构级变更，分 3 阶段交付，每阶段独立可验证。

**Goal:** 把生成器从「自己解析 formula 字符串」变成「纯翻译 AST」，配合 config 化硬编码、lint、契约测试、校验、铁律，让 AI 无法在生成器里塞口径（自由发挥写不进去/一写就暴露）。

**根因（为何重构）：** 当前 hierarchy.ts 用 `classifyDerived` + 正则模式匹配 formula（daily/rate/remaining/additive 四分支），formula 格式微变即静默返 NULL（用户已踩：剩余日均空）。tier1 与 hierarchy 两套解析逻辑不一致。AI 改生成器时能往解析分支里塞特殊口径--这就是「自由发挥」入口。

**Architecture:** 方案三档全配。核心是 L3（AST 化）--metric_registry.formula 从 TEXT 字符串改 JSONB AST，生成器变递归翻译器（无解析逻辑）。L1/L2 围绕 AST 化收口。

---

## 1. AST Schema 设计（核心）

metric_registry.formula 列改 JSONB。AST 节点：

```typescript
type Ast =
  | { t: 'ref', code: string }                    // metric_code 或窗口列(total_days/days_elapsed/latest_day/current_date)
  | { t: 'lit', v: number }                        // 数字字面量
  | { t: 'op', op: '+'|'-'|'/'|'*', l: Ast, r: Ast }
  | { t: 'call', fn: 'nullif'|'greatest'|'coalesce'|'abs', args: Ast[] }
  | { t: 'filter', expr: Ast, col: string, val: Ast }  // X FILTER (WHERE col=val)
```

**示例：**
```jsonc
// sale_rate = sale_amount / sale_target
{ "t":"op","op":"/","l":{"t":"ref","code":"sale_amount"},"r":{"t":"ref","code":"sale_target"} }

// remaining_daily_sale = (sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)
{ "t":"op","op":"/",
  "l":{"t":"op","op":"-","l":{"t":"ref","code":"sale_target"},"r":{"t":"ref","code":"sale_amount"}},
  "r":{"t":"call","fn":"nullif","args":[
    {"t":"op","op":"-","l":{"t":"ref","code":"total_days"},"r":{"t":"ref","code":"days_elapsed"}},
    {"t":"lit","v":0}]}}

// daily_sale = sale_amount FILTER(biz_date=latest_day)
{ "t":"filter","expr":{"t":"ref","code":"sale_amount"},"col":"biz_date","val":{"t":"ref","code":"latest_day"} }

// distribution_amount = delivery_amount + wholesale_pp_amount
{ "t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_pp_amount"} }
```

**round 不进 AST**（口径/格式分离）：生成器输出时按 metric.unit 决定 round 位数（unit='率'->round 4；unit='元' 且 measure_type='derived' ->round 2）。round 是输出格式，非口径，不该污染 formula。ViewConfig 可覆盖。

**窗口列集合**（生成器翻译 ref 时识别）：`{total_days, days_elapsed, latest_day, current_date}` -- 非 metric_code 的 ref 必须在此集合，否则 L1 报错。

**人读**：加 `render_formula(ast)` 函数（DB 端或生成器端），把 AST 渲染回可读串（如 `sale_amount / sale_target`），供 admin UI / 排查用。存储是 AST，人读靠渲染。

---

## 2. 分阶段交付

### 阶段 1：AST 化 + 统一翻译器（核心，消除正则）

**Files:**
- Modify: `database/migrations/076_metric_registry.sql` 等（formula 列 TEXT -> JSONB；或新迁移 ALTER）
- Create: `database/migrations/13x_formula_ast.sql`（规范化残留抽象公式 + formula 转 AST）
- Modify: `services/semantic-generator/src/types.ts`（Metric.formula 类型 string -> Ast | null）
- Create: `services/semantic-generator/src/ast.ts`（astToSql 递归翻译器 + render_formula）
- Modify: `services/semantic-generator/src/generators/tier1.ts`（删 expandAdditive/expandRate/expandToken，改用 astToSql）
- Modify: `services/semantic-generator/src/generators/hierarchy.ts`（删 classifyDerived/metricExpr/operandRef/baseRef，改用 astToSql）
- Test: `services/semantic-generator/__tests__/ast.test.ts`（契约测试）

**Steps:**

- [ ] **1.1 规范化残留抽象公式**
  残留：`profit/amount`（margin 类已部分修）、`actual/target`（profit_rate）、`(target-actual)/remaining`（remaining_daily_profit_target）。迁移把全部改成具体 metric_code（如 profit_rate -> outbound_profit/outbound_profit_target）。

- [ ] **1.2 formula 列改 JSONB AST**
  迁移：`ALTER TABLE metric_registry ALTER COLUMN formula TYPE JSONB USING ...`（或加新列 formula_ast + 保留 formula 字符串过渡，验证后删字符串）。手工映射 ~15 个现有公式 -> AST（按 §1 schema）。

- [ ] **1.3 astToSql 递归翻译器**（`src/ast.ts`）
  ```typescript
  function astToSql(node: Ast, ctx: Ctx): string {
    switch (node.t) {
      case 'ref': return resolveRef(node.code, ctx);  // metric_code->cteN.code；窗口列->tgt.col；未知->throw
      case 'lit': return String(node.v);
      case 'op': return `(${astToSql(node.l, ctx)} ${node.op} ${astToSql(node.r, ctx)})`;
      case 'call': return `${node.fn}(${node.args.map(a => astToSql(a, ctx)).join(', ')})`;
      case 'filter': return `${astToSql(node.expr, ctx)} FILTER (WHERE ${node.col} = ${astToSql(node.val, ctx)})`;
    }
  }
  ```
  resolveRef 是唯一「认 metric_code」的点。AI 想加口径 -> 只能改 AST 数据，不能改翻译器（翻译器无分支可塞）。

- [ ] **1.4 生成器改用 astToSql**
  tier1 删 expandAdditive/expandRate/expandToken/metricRef（~60 行）；hierarchy 删 classifyDerived/metricExpr/operandRef/baseRef（~110 行）。两生成器统一调 astToSql。daily FILTER 不再单独识别（AST 的 filter 节点直接翻译成 FILTER 子句，在 base CTE 里--但 daily 是 CTE 内聚合列，需 astToSql 在 actual CTE 生成时识别 filter 节点产 FILTER 列。保持现有 daily 机制但用 AST 判定）。

- [ ] **1.5 契约测试**
  每个 AST 节点类型一个测试：喂 AST fixture -> 断言产出 SQL 片段。AI 改翻译器 -> 测试挂 -> diff 显形。

- [ ] **1.6 全量 diff=0 回归**
  重新生成 brand + region 视图，L3b diff=0 vs 旧（口径不变，仅求值路径变）。

### 阶段 2：config 化硬编码 + lint 禁字面量（防字面量口径）

**Files:**
- Modify: `src/types.ts`（ViewScope 加 targetLevel/targetStatus；ViewConfig 加 round 规则）
- Modify: `generators/{tier1,hierarchy}.ts`（tgt CTE 读 config.scope.targetLevel 而非写死 'total'）
- Create: `scripts/lint-generator.mjs`（扫描 generators/*.ts 禁业务字符串字面量）

**Steps:**

- [ ] **2.1 tgt 硬编码 config 化**
  `target_level='total' AND status='active'` -> ViewScope.targetLevel='total' / targetStatus='active'。round 位数 -> ViewConfig.roundRules 或按 unit。生成器代码零业务字面量。

- [ ] **2.2 lint 禁字面量**
  脚本扫 `generators/*.ts`，禁出现：`report_daily_*`/`system_book_code`/`'3120'`/`'64188'`/`is_assessed`/`'store'`/`'total'` 等业务字面量（白名单：SQL 关键字、CTE 别名、AST 结构）。CI 跑，挂了阻断。AI 想塞 `WHERE system_book_code='64188'` -> lint 挂。

- [ ] **2.3 tier1 brand 视图 target CTE 的 breakdown_level config 化**
  写死 `'store'` -> config.targetBreakdown。

### 阶段 3：L1 校验扩展 + 铁律 + 收口（防漏 + 文档约束）

**Files:**
- Modify: `database/migrations/078_validate_semantic_registry.sql`（加 AST 校验）
- Modify: `docs/architecture.md` §10.10（铁律）
- Modify: `CLAUDE.md`（生成器约束铁律）

**Steps:**

- [ ] **3.1 L1 校验扩展（AST ref 闭环）**
  validate_semantic_registry 加：
  - derived 指标的 formula AST 里所有 ref 节点：metric_code 必须在 registry（或窗口列集合），否则报 issue。
  - additive=false 的指标 formula 顶层 op 不能是 `+`（防 rate 被当 additive 求和）。
  - daily（filter 节点）的 expr 必须是 ref 且对应 base metric。

- [ ] **3.2 铁律写入架构文档**
  architecture.md §10.10 加「生成器约束铁律」段：
  1. 生成器只读 registry AST + config，**禁止在代码里写指标口径**（解析/分支/字面量）。
  2. 新增指标 = 改 registry（formula AST）；新增视图 = 改 ViewConfig。**不改生成器代码**。
  3. 生成器代码禁业务字面量（lint 强制）。
  4. 改生成器代码前自问：是否对应一个 AST/config 新能力？自造指标处理 = 违规。

- [ ] **3.3 CLAUDE.md 同步铁律**
  在「架构变更规则」加一条：生成器改动属架构变更，先确认是否 AST/config 能覆盖。

- [ ] **3.4 全量回归 + 收口**
  重新生成全部 _gen 视图，L1 通过、L2 EXPLAIN、L3b diff=0。38+ 契约测试全过。

---

## 3. 约束效果矩阵

| 自由发挥行为 | 挡住机制 | 强度 |
|------|------|------|
| AI 在生成器加 `if formula.includes('/')` 分支 | AST 翻译器无分支（递归 switch） | 强 |
| AI 在生成器塞 `WHERE sbc='64188'` 字面量 | lint 禁字面量 | 强 |
| AI 在生成器加「某指标特殊处理」函数 | 无 metricExpr 入口（删了）；只能改 AST 数据 | 强 |
| AI 改 round 位数影响口径 | round 不在 AST（按 unit/配置），口径/格式分离 | 中 |
| AI 加新指标但 formula AST ref 指向不存在 metric | L1 校验 AST ref 闭环 | 强 |
| AI 改翻译器逻辑 | 契约测试挂 -> diff 显形 | 中 |
| AI 改 registry formula 但不更新视图 | 重新生成 + diff=0 验证 | 中 |

**没有 100%**（AI 总能改代码/测试），但组合后：口径变更必须改 registry AST（数据）+ 改翻译器会挂测试（显形）+ 业务字面量 lint 挂（阻断）。「随便塞口径」成本从「改几行生成器」升到「改 schema + 改测试 + 过 lint + 过校验」。

---

## 4. 风险

| 风险 | 缓解 |
|------|------|
| formula TEXT->JSONB 迁移破坏现有数据 | 过渡期保留 formula 字符串列，AST 验证 + diff=0 后删 |
| AST 表达力不足（现有公式有未覆盖 op） | §1 已覆盖现有全量公式 op 集合（+-/*、nullif/greatest、filter）；遗漏则 AST 报错显形 |
| 生成器重构引入 diff≠0 | 阶段1 末全量 diff=0 回归才收口 |
| lint 误杀（CTE 别名等结构字面量） | 白名单 + 渐进启用 |

---

## 验收

| 标准 | 验证 |
|------|------|
| 生成器零正则/零 formula 字符串解析 | grep 生成器代码无 `formula.split`/`/FILTER.*latest_day/` 等 |
| tier1 + hierarchy 同一翻译器 | 两生成器都调 astToSql，无各自解析 |
| 生成器代码零业务字面量 | lint 通过 |
| L1 校验 AST ref 闭环 | validate_semantic_registry 空返 |
| 契约测试覆盖 AST 节点 | 每节点类型有测试 |
| 口径不变 | 全量 _gen 视图重新生成 + L3b diff=0 vs 旧 |
| 铁律入文档 | architecture.md §10.10 + CLAUDE.md 更新 |
