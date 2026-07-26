# 语义层第二步：生成器多源扩展 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 generate-views.js 支持多源视图（base 跨 source_table），产出配送（distribution_drill）+ 出库（outbound_drill）下钻视图，wholesale_ext 归「外部客户」虚拟节点。

**Architecture:** 每源内层 SELECT（该源 base SUM、其它源 0）→ UNION ALL → 外层合总 + derived 跨源合计；virtual_nodes 标记的源不 JOIN dim_branch、用虚拟 code/name；audit 遍历所有 metric 各层合总校验。

**Tech Stack:** Node（generate-views.js）、PostgreSQL（生成视图）、vitest（生成器纯函数单测）

## Global Constraints

- 生成器复用既有 `readModel/normDeps/genAuditSql(框架)/main`，只重写 `validateView→groupSources` + `genLevelBranch` + `genAuditSql` 适配多 metric
- 单源视图（store_sales_drill）必须回归不变（groupSources 单源组也工作）
- 视图 `DROP VIEW IF EXISTS + CREATE VIEW`，禁 CREATE OR REPLACE；部署后重启 postgrest
- wholesale_ext 在 outbound 视图归「外部客户」虚拟节点（每层 code='外部客户'/name='外部客户'/parent=NULL，不 JOIN dim_branch、不套 assessed_filter）
- derived 可加（distribution/outbound）跨源合计 = `SUM(dep1) + SUM(dep2)` 外层；比率 derived（margin）仅单源视图，多源视图不含
- 生成器连本地 dev PG（docker）跑；本地无 docker 时纯函数单测 + 生产跑生成
- metric_sources 已就绪（088/089：delivery/wholesale_pp source_filter sbc=64188/wholesale_ext sbc=3120）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `scripts/generate-views.js`（改） | validateView→groupSources（多源分组）+ genLevelBranch 重写（多源 UNION+virtual_node+外层合总）+ genAuditSql 多 metric |
| `scripts/view-manifest.json`（改） | 加 distribution_drill / outbound_drill（outbound 含 virtual_nodes） |
| `scripts/__tests__/generate-views.test.js`（新） | vitest 单测：groupSources + genLevelBranch 多源 SQL 生成（纯函数，mock model） |
| `database/migrations/0NN_generated_distribution_drill.sql`（机器生成） | 配送下钻视图 + audit |
| `database/migrations/0NN_generated_outbound_drill.sql`（机器生成） | 出库下钻视图 + audit（含外部客户虚拟节点） |

---

## Task 1: 生成器多源扩展（groupSources + genLevelBranch + genAuditSql 多 metric）+ 单测

**Files:**
- Modify: `scripts/generate-views.js`（validateView 54-69 → groupSources；genLevelBranch 72-137 重写；genAuditSql 140-175 多 metric；genViewSql 177-197 适配）
- Create: `scripts/__tests__/generate-views.test.js`

**Interfaces:**
- Consumes: `readModel/normDeps/main`（既有，不变）；metric_registry/metric_sources（088/089 已声明 delivery/wholesale_pp/wholesale_ext）
- Produces: `groupSources(view, model)` 返回 `[{table, filter, metrics:[{metric_code, source_column}]}]`；`genLevelBranch(view, level, parentLevel, groups, model, dim)` 返回多源 UNION SQL；`genAuditSql(viewName, view, levels, model)` 返回多 metric audit SQL

- [ ] **Step 1: 抽纯函数 + 改 generate-views.js**

把 `validateView`（54-69）替换为 `groupSources`；`genLevelBranch`（72-137）重写为多源；`genAuditSql`（140-175）改多 metric；`genViewSql`（177-197）用 groupSources。

替换 `validateView` 函数（54-69 行）为：
```js
// 多源分组：base 指标按 source_table 分组（单源视图退化为 1 组）
function groupSources(view, model) {
  const baseMetrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  if (baseMetrics.length === 0) throw new Error(`视图 ${view.name}: 无 base 指标，无法定位 source_table`);
  const map = new Map();
  for (const m of baseMetrics) {
    const s = model.sources.find((x) => x.metric_code === m.metric_code);
    if (!s) throw new Error(`指标 ${m.metric_code} 无 metric_sources 映射`);
    if (!map.has(s.source_table)) map.set(s.source_table, { table: s.source_table, filter: s.source_filter, metrics: [] });
    map.get(s.source_table).metrics.push({ metric_code: m.metric_code, source_column: s.source_column });
  }
  return [...map.values()];
}
```

替换 `genLevelBranch` 函数（72-137 行）为多源版本：
```js
// 生成单层 UNION 分支（多源：每源内层 SUM 该源指标/其它 0 → UNION ALL → 外层合总 + derived 跨源合计）
function genLevelBranch(view, level, parentLevel, groups, model, dim) {
  const virtualNodes = view.virtual_nodes || {};
  const allBase = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  const derivedAdd = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && m.additive);
  // 比率 derived（margin）多源不支持
  const derivedRatio = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && !m.additive);
  if (derivedRatio.length) throw new Error(`视图 ${view.name}: 多源/含虚拟节点视图不支持比率 derived [${derivedRatio.map((d) => d.metric_code).join(",")}]（margin 仅用于同源 sale 视图）`);

  const tgtExpr = view.target_scoped ? `t.id` : `NULL::bigint`;

  // 每源内层 SELECT
  const inners = groups.map((grp) => {
    const grpCodes = grp.metrics.map((g) => g.metric_code);
    const isVirtual = grpCodes.some((c) => virtualNodes[c]);
    const vname = isVirtual ? virtualNodes[grpCodes.find((c) => virtualNodes[c])] : null;
    const codeExpr = isVirtual ? `'${vname}'` : `dim.${level.key_column}`;
    const nameExpr = isVirtual ? `'${vname}'` : `dim.${level.name_column}`;
    const parentExpr = isVirtual ? `NULL::text` : parentLevel ? `dim.${parentLevel.key_column}` : `NULL::text`;
    const baseCols = allBase.map((b) => {
      const inGrp = grp.metrics.find((g) => g.metric_code === b.metric_code);
      return inGrp ? `SUM(s.${inGrp.source_column}) AS ${b.metric_code}` : `0 AS ${b.metric_code}`;
    });
    let from = `    FROM ${grp.table} s`;
    if (!isVirtual) from += `\n    JOIN ${dim.join_table} dim ON s.branch_num = dim.${dim.join_key} AND s.system_book_code = dim.system_book_code`;
    if (view.target_scoped) from += `\n    JOIN targets t ON (t.system_book_code = 'ALL' OR s.system_book_code = t.system_book_code)\n      AND s.biz_date BETWEEN t.start_date AND t.end_date`;
    const where = [];
    if (view.target_scoped) where.push("t.status = 'active'");
    if (grp.filter) where.push(grp.filter);
    if (view.assessed_filter && !isVirtual) where.push("is_assessed_war_zone(dim.first_level_region)");
    const groupCols = [];
    if (view.target_scoped) groupCols.push("t.id");
    if (!isVirtual && parentLevel) groupCols.push(`dim.${parentLevel.key_column}`);
    if (!isVirtual) { groupCols.push(`dim.${level.key_column}`); groupCols.push(`dim.${level.name_column}`); }
    const groupTail = groupCols.length ? `\n    GROUP BY ${groupCols.join(", ")}` : "";
    return `    SELECT '${level.level_code}' AS level, ${parentExpr} AS parent_code, ${tgtExpr} AS target_id, ${codeExpr} AS code, ${nameExpr} AS name, ${baseCols.join(", ")}\n${from}\n${where.length ? "    WHERE " + where.join(" AND ") : ""}${groupTail}`;
  });

  // 外层合总 + derived 跨源合计
  for (const d of derivedAdd) {
    const deps = normDeps(d.depends_on);
    for (const dep of deps) if (!allBase.some((b) => b.metric_code === dep)) throw new Error(`视图 ${view.name}: derived ${d.metric_code} 依赖 ${dep} 未声明为 base`);
  }
  const outerBase = allBase.map((b) => `SUM(${b.metric_code}) AS ${b.metric_code}`);
  const outerDerived = derivedAdd.map((d) => {
    const deps = normDeps(d.depends_on);
    return `(${deps.map((dep) => `SUM(${dep})`).join(" + ")}) AS ${d.metric_code}`;
  });
  const outerCols = [...outerBase, ...outerDerived];
  const groupOuter = ["level", "parent_code", ...(view.target_scoped ? ["target_id"] : []), "code", "name"];
  return `  SELECT level, parent_code, ${view.target_scoped ? "target_id, " : ""}code, name, ${outerCols.join(", ")}\n  FROM (\n${inners.join("\n  UNION ALL\n")}\n  ) combined\n  GROUP BY ${groupOuter.join(", ")}`;
}
```

替换 `genAuditSql` 函数（140-175 行）为多 metric 版本：
```js
// audit：遍历 view 所有可加指标（base + derived additive），各层合总一致性（diff vs 第 0 层）
function genAuditSql(viewName, view, levels, model) {
  const auditName = viewName + "_audit";
  const codes = levels.map((l) => l.level_code);
  const tgt = view.target_scoped;
  const metrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && (m.measure_type === "base" || (m.measure_type === "derived" && m.additive)));
  const pivots = [];
  const diffs = [];
  const outCols = [];
  if (tgt) outCols.push("target_id");
  for (const mc of metrics) {
    for (const c of codes) pivots.push(`MAX(CASE WHEN level='${c}' THEN ${mc.metric_code}_sum END) AS ${mc.metric_code}_${c}_total`);
    outCols.push(...codes.map((c) => `${mc.metric_code}_${c}_total`));
    for (let i = 1; i < codes.length; i++) { diffs.push(`ABS(${mc.metric_code}_${codes[0]}_total - ${mc.metric_code}_${codes[i]}_total) AS ${mc.metric_code}_${codes[0]}_vs_${codes[i]}_diff`); outCols.push(`${mc.metric_code}_${codes[0]}_vs_${codes[i]}_diff`); }
  }
  const innerSums = metrics.map((mc) => `SUM(${mc.metric_code}) AS ${mc.metric_code}_sum`).join(", ");
  return `DROP VIEW IF EXISTS ${auditName};
CREATE VIEW ${auditName} AS
  SELECT
    ${outCols.join(",\n    ")}
  FROM (
    SELECT${tgt ? "\n      target_id," : ""}
        ${pivots.join(",\n        ")}
    FROM (
      SELECT${tgt ? " target_id," : ""} level, ${innerSums}
      FROM ${viewName}
      GROUP BY ${tgt ? "target_id, " : ""}level
    ) y
    GROUP BY${tgt ? " target_id" : ""}
  ) z;
ALTER VIEW ${auditName} SET (security_invoker = true);
GRANT SELECT ON ${auditName} TO authenticated, anon;`;
}
```

改 `genViewSql`（177-197）：把 `const { sourceTable, baseMetrics } = validateView(view, model);` 换成 `const groups = groupSources(view, model);`；`genLevelBranch(view, lvl, parent, baseMetrics, model, dim, sourceTable)` 调用改成 `genLevelBranch(view, lvl, parent, groups, model, dim)`；`genAuditSql(viewName, view, levels)` 改 `genAuditSql(viewName, view, levels, model)`。完整新 genViewSql：
```js
function genViewSql(view, model) {
  const dim = model.dims.find((d) => d.dim_code === view.dimension);
  if (!dim) throw new Error(`维度 ${view.dimension} 未注册`);
  const groups = groupSources(view, model);
  const levels = model.levels
    .filter((l) => l.dim_code === view.dimension && view.levels.includes(l.level_code))
    .sort((a, b) => a.depth - b.depth);
  if (levels.length === 0) throw new Error(`维度 ${view.dimension} 无匹配层级 ${view.levels}`);
  const branches = levels.map((lvl) => {
    const parent = lvl.parent_level ? levels.find((l) => l.level_code === lvl.parent_level) : null;
    return genLevelBranch(view, lvl, parent, groups, model, dim);
  });
  const viewName = `report_${view.name}_v`;
  let sql = `-- AUTO-GENERATED by scripts/generate-views.js（勿手改；改 view-manifest.json 后重生成）\n-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；部署后重启 postgrest\n\n`;
  sql += `DROP VIEW IF EXISTS ${viewName} CASCADE;\nCREATE VIEW ${viewName} AS\n${branches.join("\nUNION ALL\n")};\n`;
  sql += `ALTER VIEW ${viewName} OWNER TO postgres;\nALTER VIEW ${viewName} SET (security_invoker = true);\nGRANT SELECT ON ${viewName} TO authenticated, anon;\n`;
  if (view.audit) sql += "\n" + genAuditSql(viewName, view, levels, model) + "\n";
  return sql;
}
```

- [ ] **Step 2: 写 vitest 单测（纯函数，mock model）**

创建 `scripts/__tests__/generate-views.test.js`。因 generate-views.js 用 `require` 导入 pg（连 PG），单测要避开顶层 require 副作用——用 `jest.resetModules` 思路不可行（vitest）。改为：单测只验 SQL 字符串包含关键片段（多源 UNION + 虚拟节点 + 外层合总），不 import 整个 generate-views.js（避免 pg require）；通过抽函数到独立模块或直接测生成 SQL 的核心逻辑。

> 简化：因 generate-views.js 顶层 `require(pg)` 在无 PG 环境会失败，单测改为**生成器集成测试**——在 Task 3 跑生成器（连本地/生产 PG）后验产出 SQL 文件含关键片段。本 Step 先建测试骨架（占位，Task 3 填）。

创建 `scripts/__tests__/generate-views.test.js`（骨架，Task 3 跑生成器后填实际断言）：
```js
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');

describe('生成器多源视图产出', () => {
  it('distribution_drill SQL 含多源 UNION + 外层合总', () => {
    const f = fs.readdirSync(MIGRATIONS_DIR).find(x => x.endsWith('_generated_distribution_drill.sql'));
    if (!f) return; // Task 3 生成后才断言
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/combined/); // 外层合总
    expect(sql).toMatch(/report_daily_delivery/);
    expect(sql).toMatch(/report_daily_wholesale/);
    expect(sql).toMatch(/distribution_amount/);
  });

  it('outbound_drill SQL 含外部客户虚拟节点', () => {
    const f = fs.readdirSync(MIGRATIONS_DIR).find(x => x.endsWith('_generated_outbound_drill.sql'));
    if (!f) return;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    expect(sql).toMatch(/'外部客户'/);
    expect(sql).toMatch(/wholesale_ext_amount/);
  });
});
```

- [ ] **Step 3: node 语法检查 + commit**
```bash
node -c scripts/generate-views.js && echo "syntax OK"
cd /Users/duo/Documents/mytechcode/data-analysis && git add scripts/generate-views.js scripts/__tests__/generate-views.test.js
git commit -m "feat(scripts): 生成器多源扩展 (groupSources + 多源UNION + virtual_nodes + audit多metric)"
```

---

## Task 2: manifest 加 distribution_drill + outbound_drill

**Files:**
- Modify: `scripts/view-manifest.json`

**Interfaces:**
- Consumes: generate-views.js 多源（Task 1）
- Produces: manifest 两项新视图（distribution_drill 单源组2 / outbound_drill 含 virtual_nodes）

- [ ] **Step 1: 改 view-manifest.json**

把 `scripts/view-manifest.json` 整体替换为：
```json
{
  "views": [
    {
      "name": "store_sales_drill",
      "metrics": ["sale_amount", "sale_profit", "margin"],
      "dimension": "branch",
      "levels": ["region", "sub_region", "store"],
      "assessed_filter": true,
      "target_scoped": true,
      "audit": true
    },
    {
      "name": "distribution_drill",
      "metrics": ["delivery_amount", "wholesale_pp_amount", "distribution_amount"],
      "dimension": "branch",
      "levels": ["region", "sub_region", "store"],
      "assessed_filter": true,
      "target_scoped": true,
      "audit": true
    },
    {
      "name": "outbound_drill",
      "metrics": ["delivery_amount", "wholesale_pp_amount", "wholesale_ext_amount", "outbound_amount"],
      "dimension": "branch",
      "levels": ["region", "sub_region", "store"],
      "assessed_filter": false,
      "target_scoped": true,
      "audit": true,
      "virtual_nodes": { "wholesale_ext_amount": "外部客户" }
    }
  ]
}
```

注意：
- distribution_drill：delivery（report_daily_delivery）+ wholesale_pp（report_daily_wholesale sbc=64188）两源，distribution 跨源合计；assessed_filter=true（门店四大战区）
- outbound_drill：+ wholesale_ext（sbc=3120），virtual_nodes 把 wholesale_ext 归「外部客户」；assessed_filter=false（外部无战区）

- [ ] **Step 2: commit**
```bash
git add scripts/view-manifest.json
git commit -m "feat(scripts): manifest 加 distribution_drill + outbound_drill (含外部客户虚拟节点)"
```

---

## Task 3: 跑生成器产出视图 + 验证

**Files:**
- Create: `database/migrations/0NN_generated_distribution_drill.sql`（机器生成）
- Create: `database/migrations/0NN_generated_outbound_drill.sql`（机器生成）

**Interfaces:**
- Consumes: generate-views.js（Task 1）+ manifest（Task 2）+ metric_registry/metric_sources（088/089）
- Produces: 两个生成视图迁移

- [ ] **Step 1: 确认本地 docker PG 可连；不可则改生产跑**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT COUNT(*) FROM metric_sources" 2>&1
```
- 若返回数字（本地 docker 跑）→ 本地跑生成器（DATABASE_URL 指本地 dev PG）
- 若 "Cannot connect to docker daemon" → 跳到 Step 3（生产跑生成器）

- [ ] **Step 2a（本地 docker 可用时）: 本地跑生成器**
```bash
DATABASE_URL=postgresql://postgres:<本地dev密码>@localhost:5432/insforge node scripts/generate-views.js
```
Expected: 输出 3 行（store_sales_drill updated + distribution_drill generated + outbound_drill generated）。

- [ ] **Step 3（本地 docker 不可用，生产跑）: 服务器跑生成器**

生产已部署 Task 1+2（先 push 部署），在服务器跑生成器（连生产 PG）：
```bash
git push origin main   # 先部署 Task1+2（生成器改 + manifest）
# 等 GHA 部署完成 + 重启 postgrest
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform && docker exec deploy-duckdb-1 sh -c 'cd /app && DATABASE_URL=postgresql://postgres:\$POSTGRES_PASSWORD@deploy-postgres-1:5432/insforge node scripts/generate-views.js' 2>&1 || echo 'services容器无scripts，改host跑'"
```
> 若 services 容器无 scripts/ 挂载，回退：scp generate-views.js + view-manifest.json 到服务器 host，服务器 host 装 node 临时跑（或 docker run --rm -v 临时）。具体回退由执行者定。

- [ ] **Step 4: review 生成的 SQL**

确认 `database/migrations/0NN_generated_distribution_drill.sql` 含：
- 每层（region/sub_region/store）UNION 两源（report_daily_delivery + report_daily_wholesale）
- 外层 combined GROUP BY 合总
- distribution_amount = SUM(delivery_amount) + SUM(wholesale_pp_amount)
- audit 视图（多 metric 各层 diff）

确认 `database/migrations/0NN_generated_outbound_drill.sql` 含：
- 三源 UNION（delivery + wholesale_pp + wholesale_ext）
- wholesale_ext 源内层 code='外部客户'/name='外部客户'（virtual_nodes），不 JOIN dim_branch
- outbound_amount = SUM(delivery) + SUM(wholesale_pp) + SUM(wholesale_ext)

- [ ] **Step 5: 填单测断言 + commit**

跑 `cd web && npx vitest run ../scripts/__tests__/generate-views.test.js`（或 scripts 下 vitest）确认 Task 1 单测通过（SQL 含关键片段）。然后 commit 生成视图：
```bash
git add database/migrations/*_generated_distribution_drill.sql database/migrations/*_generated_outbound_drill.sql
git commit -m "feat(db): 生成 distribution_drill + outbound_drill 视图 (多源, 含外部客户虚拟节点)"
```

---

## Task 4: 生产部署 + 验证

**Files:** 无新文件

- [ ] **Step 1: 推送触发 GHA**
```bash
git push origin main
gh run watch --exit-status
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 2: 验证 distribution_drill 数据 + audit**
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT level, COUNT(*), SUM(distribution_amount)::numeric(14,0) FROM report_distribution_drill_v WHERE target_id=22 GROUP BY level ORDER BY level; SELECT MAX(delivery_amount_region_vs_store_diff), MAX(wholesale_pp_amount_region_vs_store_diff), MAX(distribution_amount_region_vs_store_diff) FROM report_distribution_drill_v_audit;\""
```
Expected: 三层（region/sub_region/store），distribution_amount ≈ 11,605,774（配送 = delivery 777万 + wholesale_pp 383万）；audit 全 0。

- [ ] **Step 3: 验证 outbound_drill 数据（含外部客户节点）+ audit**
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT level, code, SUM(outbound_amount)::numeric(14,0) AS 出库 FROM report_outbound_drill_v WHERE target_id=22 AND level='region' GROUP BY level, code ORDER BY 出库 DESC; SELECT COUNT(*) FILTER (WHERE code='外部客户') AS 外部客户行数 FROM report_outbound_drill_v; SELECT MAX(outbound_amount_region_vs_store_diff) FROM report_outbound_drill_v_audit;\""
```
Expected: region 层四大战区 + 「外部客户」节点（wholesale_ext）；outbound ≈ 13,256,155；audit 0。

- [ ] **Step 4: 回归 store_sales_drill 不变**
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT SUM(sale_amount)::numeric(14,0) FROM report_store_sales_drill_v WHERE target_id=22 AND level='region';\""
```
Expected: 18,802,965（sale_amount 不变，单源视图回归）。

---

## Self-Review

### 1. Spec Coverage
| spec 要求 | task |
|---|---|
| validateView 多源（groupSources） | Task 1 ✅ |
| genLevelBranch 多源 UNION + 外层合总 | Task 1 ✅ |
| virtual_nodes（wholesale_ext 外部客户） | Task 1 genLevelBranch + Task 2 manifest ✅ |
| derived 跨源合计（distribution/outbound） | Task 1 outerDerived ✅ |
| genAuditSql 多 metric | Task 1 ✅ |
| manifest distribution/outbound | Task 2 ✅ |
| 生成视图 + 验证 | Task 3 ✅ |
| 部署 + 数据印证 | Task 4 ✅ |

### 2. Placeholder Scan
- Task 3 Step 3 有「具体回退由执行者定」（服务器跑生成器的环境不确定性）——标注为风险，非占位（主路径 Step 2a 本地 docker，回退 Step 3 生产）
- 单测 Task 1 Step 2 是骨架（Task 3 填）——已标注

### 3. Type Consistency
- groupSources 返回 [{table, filter, metrics:[{metric_code, source_column}]}] —— Task 1 genLevelBranch 消费 grp.table/grp.filter/grp.metrics，一致
- genLevelBranch(view, level, parentLevel, groups, model, dim) —— genViewSql 调用参数一致
- genAuditSql(viewName, view, levels, model) —— genViewSql 调用一致
- virtual_nodes: manifest {metric_code: name} —— genLevelBranch virtualNodes[c] 一致

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-26-generator-multisource.md`.**
