# 语义层生成器 P0（地基）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起语义层构建期生成器的地基：补全 registry（6 孤儿 + 2 outbound target 度量 + 结构化 source_filter）、起 `services/semantic-generator/` TS 骨架（能跑空产物）、migrate.sh 扫 `database/generated/`、deploy.sh 迁移后 restart postgrest。

**Architecture:** 构建期生成器（非运行时引擎）——Node/TS 脚本读 `metric_registry`+`metric_sources` 产出静态视图 SQL 入 git；产物由 migrate.sh 扫描部署；三层校验（L1 静态/L2 EXPLAIN/L3 双轨+rollup）。P0 只搭地基与空跑，Tier1 生成逻辑放 P1。

**Tech Stack:** TypeScript 5、tsx（运行）、vitest（测试）、pg（读 PG）、psql（迁移）、bash（deploy.sh/migrate.sh）。

## Global Constraints（源自 spec §9，每个 task 隐含遵守）

- 迁移文件幂等：`CREATE TABLE IF NOT EXISTS` / `INSERT ON CONFLICT DO UPDATE` / 视图 `DROP VIEW IF EXISTS + CREATE VIEW`（禁 `CREATE OR REPLACE`）。
- 字符串字段用 TEXT（外部系统数据），VARCHAR 只用于自控枚举。
- 门店键 = `(system_book_code, branch_num)` 复合，禁 `branch_num` 单独 join/去重/PK。
- 加表/加列/加视图后必须 `docker compose restart postgrest` 刷 schema 缓存。
- 生成器产物进 git，可 review 可回滚；不做运行时动态 SQL。
- 比率指标（additive=false）不可直接 SUM，须 `SUM(profit)/SUM(amount)` 重算。

## File Structure（本计划涉及）

| 文件 | 责任 | 动作 |
|---|---|---|
| `database/migrations/123_semantic_orphans_and_targets.sql` | 注册 6 孤儿 + 2 outbound target 度量 + 结构化 metric_sources | 新建 |
| `database/generated/.gitkeep` | 占位，让目录入 git | 新建 |
| `scripts/migrate.sh` | 扫 `database/migrations/` + `database/generated/` | 改 |
| `scripts/deploy.sh` | 迁移后 restart postgrest | 改 |
| `services/semantic-generator/package.json` | TS 子项目依赖（tsx/vitest/pg） | 新建 |
| `services/semantic-generator/tsconfig.json` | TS 配置 | 新建 |
| `services/semantic-generator/src/registry-reader.ts` | 读 metric_registry+metric_sources → typed 对象 | 新建 |
| `services/semantic-generator/src/types.ts` | Metric/Source/ViewConfig 类型 | 新建 |
| `services/semantic-generator/src/explain.ts` | L2 EXPLAIN 工具 | 新建 |
| `services/semantic-generator/src/diff.ts` | L3b 双轨 SUM diff 工具 | 新建 |
| `services/semantic-generator/src/index.ts` | gen-views CLI 入口（P0 空跑） | 新建 |
| `services/semantic-generator/src/__tests__/registry-reader.test.ts` | reader 单测 | 新建 |
| `services/semantic-generator/src/__tests__/explain.test.ts` | EXPLAIN 工具单测 | 新建 |
| `services/semantic-generator/src/__tests__/diff.test.ts` | diff 工具单测 | 新建 |
| `services/semantic-generator/src/__tests__/index.test.ts` | CLI 空跑单测 | 新建 |
| `services/semantic-generator/.env.example` | DATABASE_URL 示例 | 新建 |
| `docs/architecture.md` | §10 语义层定位更新 | 改 |

---

## Task 1: 迁移 123 — 注册孤儿指标 + outbound target 度量 + 结构化 source_filter

**Files:**
- Create: `database/migrations/123_semantic_orphans_and_targets.sql`

**Interfaces:**
- Produces: metric_registry 新增 8 行 + metric_sources 新增 target 度量 source 行；供 P1+ 生成器读取。

- [ ] **Step 1: 写迁移 SQL**

创建 `database/migrations/123_semantic_orphans_and_targets.sql`：

```sql
-- 123_semantic_orphans_and_targets.sql
-- 补齐语义层：6 孤儿指标 + 2 outbound target 度量 + 结构化 metric_sources（target 度量的 source_filter）
-- 幂等：INSERT ON CONFLICT DO UPDATE；部署后 restart postgrest。
-- 关联：spec docs/superpowers/specs/2026-07-31-semantic-layer-generator-wiring-design.md §3

BEGIN;

-- ===== 1. 2 个 outbound target 度量（base，target_metric_values）=====
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, formula, depends_on, additive, cost_sensitive, unit, data_ready, enabled) VALUES
  ('outbound_amount_target','出库金额目标','target_metric_values(target_value) metric_code=outbound_amt 按分解级','SUM(target_value) WHERE metric_code=outbound_amt','base','target_metric_values','target_value','SUM',NULL,'[]'::jsonb,true,false,'元',true,true),
  ('outbound_profit_target','出库毛利目标','target_metric_values(target_value) metric_code=outbound_profit 按分解级','SUM(target_value) WHERE metric_code=outbound_profit','base','target_metric_values','target_value','SUM',NULL,'[]'::jsonb,true,false,'元',true,true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column,
  agg=EXCLUDED.agg, additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- ===== 2. 6 个孤儿指标（derived）=====
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, formula, depends_on, additive, cost_sensitive, unit, data_ready, enabled) VALUES
  ('delivery_margin','配送毛利率','配送毛利/配送金额','delivery_profit / delivery_amount','derived','profit / amount','["delivery_profit","delivery_amount"]'::jsonb,false,true,'%',true,true),
  ('profit_rate','利润完成率','出库毛利/出库毛利目标','outbound_profit / outbound_profit_target','derived','actual / target','["outbound_profit","outbound_profit_target"]'::jsonb,false,false,'率',true,true),
  ('daily_amount','当日出库金额','outbound_amount 当天(biz_date=latest_day)','outbound_amount FILTER(biz_date=latest_day)','derived','amount FILTER(latest_day)','["outbound_amount"]'::jsonb,true,false,'元',true,true),
  ('daily_profit','当日出库毛利','outbound_profit 当天','outbound_profit FILTER(biz_date=latest_day)','derived','amount FILTER(latest_day)','["outbound_profit"]'::jsonb,true,true,'元'),
  ('daily_profit_margin','当日出库毛利率','daily_profit / daily_amount','daily_profit / daily_amount','derived','profit / amount','["daily_profit","daily_amount"]'::jsonb,false,true,'%',true,true),
  ('remaining_daily_profit_target','剩余日均利润目标','(outbound_profit_target - outbound_profit) / nullif(remaining_days,0)','(target - actual) / nullif(remaining_days, 0)','derived','(target - actual) / remaining','["outbound_profit","outbound_profit_target"]'::jsonb,true,false,'元',true,true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, formula=EXCLUDED.formula, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- ===== 3. metric_sources：结构化 target 度量 source_filter =====
-- 119 注册了 sale_target/delivery_target 但没补 metric_sources 行；此处补齐 4 个 target 度量
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
SELECT v.metric_code, v.source_table, v.source_column, v.source_filter, v.note
FROM (VALUES
  ('sale_target','target_metric_values','target_value','metric_code=''sale''','销售目标（target_metric_values metric_code=sale）'),
  ('delivery_target','target_metric_values','target_value','metric_code=''delivery''','配送目标'),
  ('outbound_amount_target','target_metric_values','target_value','metric_code=''outbound_amt''','出库金额目标'),
  ('outbound_profit_target','target_metric_values','target_value','metric_code=''outbound_profit''','出库毛利目标')
) AS v(metric_code, source_table, source_column, source_filter, note)
WHERE EXISTS (SELECT 1 FROM metric_registry WHERE metric_code = v.metric_code)
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

COMMIT;

DO $$ BEGIN RAISE NOTICE 'Migration 123: 6 orphans + 2 outbound targets + 4 target metric_sources'; END $$;
```

- [ ] **Step 2: 本地验证迁移幂等**

Run:
```bash
bash scripts/migrate.sh
bash scripts/migrate.sh  # 第二次跑，验证幂等不报错
```
Expected: 第二次执行无 ERROR，Notice 输出 "Migration 123: ...".

- [ ] **Step 3: 验证 registry 行数**

Run:
```bash
docker compose exec -T postgres psql -U postgres -d insforge -c \
  "SELECT metric_code, measure_type FROM metric_registry WHERE metric_code IN ('delivery_margin','profit_rate','daily_amount','daily_profit','daily_profit_margin','remaining_daily_profit_target','outbound_amount_target','outbound_profit_target') ORDER BY metric_code;"
```
Expected: 8 行返回。

- [ ] **Step 4: 验证 metric_sources 结构化 source_filter**

Run:
```bash
docker compose exec -T postgres psql -U postgres -d insforge -c \
  "SELECT metric_code, source_filter FROM metric_sources WHERE metric_code LIKE '%_target' ORDER BY metric_code;"
```
Expected: 4 行（sale_target/delivery_target/outbound_amount_target/outbound_profit_target），source_filter 非 NULL。

- [ ] **Step 5: 跑 L1 静态校验**

Run:
```bash
docker compose exec -T postgres psql -U postgres -d insforge -c \
  "SELECT * FROM validate_semantic_registry();"
```
Expected: 0 行（无 issue）。如有 issue，修迁移后重跑。

- [ ] **Step 6: Commit**

```bash
git add database/migrations/123_semantic_orphans_and_targets.sql
git commit -m "feat(semantic): 迁移123 注册6孤儿+2 outbound target+结构化target source_filter"
```

---

## Task 2: database/generated/ 目录 + migrate.sh 扫描

**Files:**
- Create: `database/generated/.gitkeep`
- Modify: `scripts/migrate.sh`

**Interfaces:**
- Produces: `database/generated/` 目录入 git；migrate.sh 会按文件名顺序执行其中 `*.sql`。

- [ ] **Step 1: 建目录占位**

```bash
mkdir -p database/generated
touch database/generated/.gitkeep
```

- [ ] **Step 2: 改 migrate.sh 加 generated 扫描**

Modify `scripts/migrate.sh` — 在现有 `migrations` 循环之后、`echo "✅ 迁移完成"` 之前，插入 generated 循环。

把这段：
```bash
shopt -u nullglob
echo "✅ 迁移完成"
```
替换为：
```bash
shopt -u nullglob

# 生成器产物（services/semantic-generator 产出，DROP+CREATE 幂等）
GENERATED_DIR="$ROOT/database/generated"
if [ -d "$GENERATED_DIR" ]; then
  echo "▶ 执行生成器产物（${GENERATED_DIR}）..."
  shopt -s nullglob
  for sql in "$GENERATED_DIR"/*.sql; do
    name="$(basename "$sql")"
    echo "  · $name"
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
      -U "$PGUSER" -d "$PGDB" -f "/generated/$name"
  done
  shopt -u nullglob
fi

echo "✅ 迁移完成"
```

> 注：generated 目录需挂载到容器 `/generated`。Step 3 处理挂载。

- [ ] **Step 3: 确认 generated 目录挂载进 postgres 容器**

Read `deploy/docker-compose.yml`（或 base compose）查 postgres volumes 挂载。若 `database/migrations` 已挂到 `/migrations`，则同理加一行挂 `database/generated:/generated`。

Run:
```bash
grep -n "migrations" deploy/docker-compose.yml
```
Expected: 看到类似 `- ../database/migrations:/migrations` 的 volumes 行。

在该 volumes 块加一行 `- ../database/generated:/generated`（照搬 migrations 挂载的相邻行格式）。若无 migrations 挂载（compose 用了别的机制），向用户确认挂载方式再改。

- [ ] **Step 4: 本地验证 migrate.sh 扫到 generated（空目录不报错）**

Run:
```bash
bash scripts/migrate.sh 2>&1 | grep -i "生成器产物\|✅"
```
Expected: 输出含 "▶ 执行生成器产物" 和 "✅ 迁移完成"（generated 为空，无 .sql 循环，不报错）。

- [ ] **Step 5: Commit**

```bash
git add database/generated/.gitkeep scripts/migrate.sh deploy/docker-compose.yml
git commit -m "feat(deploy): migrate.sh 扫 database/generated + 挂载到容器 /generated"
```

---

## Task 3: deploy.sh 迁移后 restart postgrest

**Files:**
- Modify: `scripts/deploy.sh`

**Interfaces:**
- Produces: 每次 GHA/手动部署 migrate 后自动 restart postgrest，刷 schema 缓存（视图变更生效）。

- [ ] **Step 1: 改 deploy.sh，migrate 后加 restart postgrest**

Modify `scripts/deploy.sh` — 找到：
```bash
echo "==== [3/5] 数据库迁移 ===="
bash "$ROOT/scripts/migrate.sh"

echo "==== [4/5] 部署 edge functions + secrets ===="
```
替换为：
```bash
echo "==== [3/5] 数据库迁移 ===="
bash "$ROOT/scripts/migrate.sh"

# 刷 PostgREST schema 缓存：migrate 改表/视图后必须重启，否则 400 "Could not find ... in the schema cache"
echo "  · restart postgrest（刷 schema 缓存）"
$COMPOSE restart postgrest

echo "==== [4/5] 部署 edge functions + secrets ===="
```

- [ ] **Step 2: 验证 deploy.sh 语法**

Run:
```bash
bash -n scripts/deploy.sh
```
Expected: 无输出（语法 OK）。

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(deploy): migrate 后 restart postgrest 刷 schema 缓存"
```

---

## Task 4: services/semantic-generator/ TS 项目骨架

**Files:**
- Create: `services/semantic-generator/package.json`
- Create: `services/semantic-generator/tsconfig.json`
- Create: `services/semantic-generator/.env.example`
- Create: `services/semantic-generator/src/types.ts`

**Interfaces:**
- Produces: 可 `npm install` + `npm test` 的 TS 子项目；`types.ts` 定义 `Metric`/`MetricSource`/`ViewConfig` 类型，供后续 task 使用。

- [ ] **Step 1: 写 package.json**

Create `services/semantic-generator/package.json`：
```json
{
  "name": "semantic-generator",
  "version": "0.1.0",
  "private": true,
  "description": "构建期视图生成器：读 metric_registry+metric_sources 产出静态视图 SQL",
  "type": "module",
  "scripts": {
    "gen-views": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "pg": "^8.13.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/pg": "^8.11.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

Create `services/semantic-generator/tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: 写 .env.example**

Create `services/semantic-generator/.env.example`：
```
# 生成器读 metric_registry 的 PG 连接（本地 dev 或 SSH 隧道到 prod）
DATABASE_URL=postgres://postgres:postgres@localhost:5432/insforge
```

- [ ] **Step 4: 写 src/types.ts**

Create `services/semantic-generator/src/types.ts`：
```typescript
// 语义层类型：从 metric_registry / metric_sources 读出的 typed 视图

export type MeasureType = 'base' | 'derived';
export type Agg = 'SUM' | 'COUNT_DISTINCT' | 'AVG' | 'MAX' | 'MIN' | null;

export interface Metric {
  metric_code: string;
  name: string;
  description: string | null;
  business_formula: string | null;
  measure_type: MeasureType;
  fact_table: string | null;
  value_column: string | null;
  agg: Agg;
  formula: string | null;
  depends_on: string[];
  additive: boolean;
  cost_sensitive: boolean;
  unit: string;
  data_ready: boolean;
  enabled: boolean;
}

export interface MetricSource {
  metric_code: string;
  source_table: string;
  source_column: string | null;
  source_filter: string | null;
  note: string | null;
}

// 视图配置：生成器按配置产出 report_*_gen.sql。P0 无配置（空跑），P1 起填充。
export interface ViewConfig {
  view_name: string;            // report_brand_metric_gen
  metrics: string[];            // metric_code 列表
  dim_code: string | null;      // 维度（branch/item/customer），null=无下钻
  levels: string[];             // 维度层级 level_code 列表
  target_metric_codes: string[];// 哪些 metric_code 需 join target_metric_values
}
```

- [ ] **Step 5: 安装依赖**

Run:
```bash
cd services/semantic-generator && npm install --registry=https://registry.npmmirror.com
```
Expected: 安装成功，node_modules 生成。

- [ ] **Step 6: 验证 npm test 能跑（无测试时通过）**

Run:
```bash
cd services/semantic-generator && npm test
```
Expected: vitest 提示 "No test files found" 但退出码 0（或 1——若 vitest 要求至少一个测试，下个 task 会补）。若退出码 1 且阻断，先在 Step 6 跳过；Task 5 会建第一个测试。

- [ ] **Step 7: Commit**

```bash
git add services/semantic-generator/package.json services/semantic-generator/tsconfig.json services/semantic-generator/.env.example services/semantic-generator/src/types.ts
# node_modules 不提交：建 .gitignore
cat > services/semantic-generator/.gitignore <<'EOF'
node_modules/
dist/
.env
EOF
git add services/semantic-generator/.gitignore
git commit -m "feat(semantic): services/semantic-generator TS 骨架 + types"
```

---

## Task 5: Registry reader（TDD）

**Files:**
- Create: `services/semantic-generator/src/registry-reader.ts`
- Test: `services/semantic-generator/src/__tests__/registry-reader.test.ts`

**Interfaces:**
- Consumes: `Metric`/`MetricSource` from `src/types.ts`
- Produces: `readRegistry(pgClient): Promise<{ metrics: Metric[]; sources: MetricSource[] }>`、`parseMetric(row): Metric`（纯函数，供测试）。

- [ ] **Step 1: 写失败测试**

Create `services/semantic-generator/src/__tests__/registry-reader.test.ts`：
```typescript
import { describe, it, expect } from 'vitest';
import { parseMetric, parseSource } from '../registry-reader.js';

describe('parseMetric', () => {
  it('把 PG 行（depends_on 是 jsonb 串）解析成 Metric', () => {
    const row = {
      metric_code: 'outbound_amount',
      name: '出库金额',
      description: '总部→所有客户',
      business_formula: 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
      measure_type: 'derived',
      fact_table: null,
      value_column: null,
      agg: null,
      formula: 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
      depends_on: '["delivery_amount","wholesale_pp_amount","wholesale_ext_amount"]',
      additive: true,
      cost_sensitive: false,
      unit: '元',
      data_ready: true,
      enabled: true,
    };
    const m = parseMetric(row);
    expect(m.metric_code).toBe('outbound_amount');
    expect(m.measure_type).toBe('derived');
    expect(m.additive).toBe(true);
    expect(m.depends_on).toEqual([
      'delivery_amount', 'wholesale_pp_amount', 'wholesale_ext_amount',
    ]);
  });

  it('base 指标 depends_on 为空数组', () => {
    const row = {
      metric_code: 'sale_amount', name: '销售金额', description: null,
      business_formula: null, measure_type: 'base', fact_table: 'retail_detail',
      value_column: 'sale_money', agg: 'SUM', formula: null,
      depends_on: '[]', additive: true, cost_sensitive: false, unit: '元',
      data_ready: true, enabled: true,
    };
    expect(parseMetric(row).depends_on).toEqual([]);
    expect(parseMetric(row).agg).toBe('SUM');
  });
});

describe('parseSource', () => {
  it('解析 source 行保留 source_filter', () => {
    const row = {
      metric_code: 'sale_target', source_table: 'target_metric_values',
      source_column: 'target_value', source_filter: "metric_code='sale'",
      note: '销售目标',
    };
    const s = parseSource(row);
    expect(s.metric_code).toBe('sale_target');
    expect(s.source_filter).toBe("metric_code='sale'");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/registry-reader.test.ts
```
Expected: FAIL（模块找不到 `../registry-reader.js`）。

- [ ] **Step 3: 写最小实现**

Create `services/semantic-generator/src/registry-reader.ts`：
```typescript
import type { PoolClient } from 'pg';
import type { Metric, MetricSource } from './types.js';

// 纯函数：PG 行（depends_on 为 JSON 字符串）→ typed Metric
export function parseMetric(row: Record<string, unknown>): Metric {
  return {
    metric_code: String(row.metric_code),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    business_formula: row.business_formula == null ? null : String(row.business_formula),
    measure_type: row.measure_type as Metric['measure_type'],
    fact_table: row.fact_table == null ? null : String(row.fact_table),
    value_column: row.value_column == null ? null : String(row.value_column),
    agg: row.agg == null ? null : (row.agg as Metric['agg']),
    formula: row.formula == null ? null : String(row.formula),
    depends_on: Array.isArray(row.depends_on)
      ? row.depends_on.map(String)
      : JSON.parse(String(row.depends_on ?? '[]')),
    additive: Boolean(row.additive),
    cost_sensitive: Boolean(row.cost_sensitive),
    unit: String(row.unit),
    data_ready: Boolean(row.data_ready),
    enabled: Boolean(row.enabled),
  };
}

export function parseSource(row: Record<string, unknown>): MetricSource {
  return {
    metric_code: String(row.metric_code),
    source_table: String(row.source_table),
    source_column: row.source_column == null ? null : String(row.source_column),
    source_filter: row.source_filter == null ? null : String(row.source_filter),
    note: row.note == null ? null : String(row.note),
  };
}

export async function readRegistry(client: PoolClient): Promise<{ metrics: Metric[]; sources: MetricSource[] }> {
  const metricRes = await client.query('SELECT * FROM metric_registry ORDER BY metric_code');
  const sourceRes = await client.query('SELECT * FROM metric_sources ORDER BY metric_code');
  return {
    metrics: metricRes.rows.map(parseMetric),
    sources: sourceRes.rows.map(parseSource),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/registry-reader.test.ts
```
Expected: PASS（3 个测试全过）。

- [ ] **Step 5: Commit**

```bash
git add services/semantic-generator/src/registry-reader.ts services/semantic-generator/src/__tests__/registry-reader.test.ts
git commit -m "feat(semantic): registry-reader + parseMetric/parseSource 单测"
```

---

## Task 6: L2 EXPLAIN 工具（TDD）

**Files:**
- Create: `services/semantic-generator/src/explain.ts`
- Test: `services/semantic-generator/src/__tests__/explain.test.ts`

**Interfaces:**
- Produces: `explainSql(client, sql): Promise<{ ok: boolean; error?: string }>`——对 SQL 跑 `EXPLAIN`，语法/字段错当场返 `ok:false`。

- [ ] **Step 1: 写失败测试**

Create `services/semantic-generator/src/__tests__/explain.test.ts`：
```typescript
import { describe, it, expect, vi } from 'vitest';
import { explainSql } from '../explain.js';

describe('explainSql', () => {
  it('EXPLAIN 成功 → ok:true', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': 'Seq Scan...' }] }),
    };
    const r = await explainSql(client as any, 'SELECT 1');
    expect(r.ok).toBe(true);
    expect(client.query).toHaveBeenCalledWith('EXPLAIN SELECT 1');
  });

  it('EXPLAIN 抛错 → ok:false 带 error', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('relation "nope" does not exist')),
    };
    const r = await explainSql(client as any, 'SELECT * FROM nope');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not exist');
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/explain.test.ts
```
Expected: FAIL（模块找不到）。

- [ ] **Step 3: 写实现**

Create `services/semantic-generator/src/explain.ts`：
```typescript
import type { PoolClient } from 'pg';

export interface ExplainResult {
  ok: boolean;
  error?: string;
}

export async function explainSql(client: PoolClient, sql: string): Promise<ExplainResult> {
  try {
    await client.query(`EXPLAIN ${sql}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/explain.test.ts
```
Expected: PASS（2 个测试）。

- [ ] **Step 5: Commit**

```bash
git add services/semantic-generator/src/explain.ts services/semantic-generator/src/__tests__/explain.test.ts
git commit -m "feat(semantic): L2 explainSql 工具 + 单测"
```

---

## Task 7: L3b 双轨 diff 工具（TDD）

**Files:**
- Create: `services/semantic-generator/src/diff.ts`
- Test: `services/semantic-generator/src/__tests__/diff.test.ts`

**Interfaces:**
- Produces: `sumDiff(oldRows, newRows, col): { col: string; oldSum: number; newSum: number; diff: number }[]`——纯函数，比两份查询结果的各列 SUM。

- [ ] **Step 1: 写失败测试**

Create `services/semantic-generator/src/__tests__/diff.test.ts`：
```typescript
import { describe, it, expect } from 'vitest';
import { sumDiff } from '../diff.js';

describe('sumDiff', () => {
  it('各列 SUM 相等 → diff 全 0', () => {
    const oldRows = [{ a: 10, b: 20 }, { a: 5, b: 7 }];
    const newRows = [{ a: 13, b: 25 }, { a: 2, b: 2 }];
    const d = sumDiff(oldRows, newRows, ['a', 'b']);
    expect(d).toEqual([
      { col: 'a', oldSum: 15, newSum: 15, diff: 0 },
      { col: 'b', oldSum: 27, newSum: 27, diff: 0 },
    ]);
  });

  it('列不等 → diff 非零', () => {
    const d = sumDiff([{ x: 100 }], [{ x: 90 }], ['x']);
    expect(d[0].diff).toBe(10);
  });

  it('null 值按 0 计', () => {
    const d = sumDiff([{ x: null }], [{ x: 5 }], ['x']);
    expect(d[0].oldSum).toBe(0);
    expect(d[0].diff).toBe(-5);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/diff.test.ts
```
Expected: FAIL（模块找不到）。

- [ ] **Step 3: 写实现**

Create `services/semantic-generator/src/diff.ts`：
```typescript
// L3b 双轨对账：比旧手写视图 vs 新生成视图各列 SUM
export interface ColDiff {
  col: string;
  oldSum: number;
  newSum: number;
  diff: number;
}

function sumCol(rows: Record<string, unknown>[], col: string): number {
  return rows.reduce((acc, r) => acc + Number(r[col] ?? 0), 0);
}

export function sumDiff(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  cols: string[],
): ColDiff[] {
  return cols.map((col) => {
    const oldSum = sumCol(oldRows, col);
    const newSum = sumCol(newRows, col);
    return { col, oldSum, newSum, diff: Math.round((oldSum - newSum) * 100) / 100 };
  });
}
```

- [ ] **Step 4: 跑确认通过**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/diff.test.ts
```
Expected: PASS（3 个测试）。

- [ ] **Step 5: Commit**

```bash
git add services/semantic-generator/src/diff.ts services/semantic-generator/src/__tests__/diff.test.ts
git commit -m "feat(semantic): L3b sumDiff 双轨对账工具 + 单测"
```

---

## Task 8: gen-views CLI 入口（P0 空跑，TDD）

**Files:**
- Create: `services/semantic-generator/src/index.ts`
- Test: `services/semantic-generator/src/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `readRegistry` from `registry-reader.ts`、`ViewConfig` from `types.ts`、`pg.Pool`。
- Produces: `runGenerator({ client, viewConfigs, outDir }): Promise<{ produced: string[]; explainFailures: string[] }>`——P0 viewConfigs=[] → produced=[]，空跑。CLI 入口 `npm run gen-views` 读 DATABASE_URL 连 PG 调 runGenerator。

- [ ] **Step 1: 写失败测试**

Create `services/semantic-generator/src/__tests__/index.test.ts`：
```typescript
import { describe, it, expect, vi } from 'vitest';
import { runGenerator } from '../index.js';

describe('runGenerator', () => {
  it('空 viewConfigs → 不产出、不 EXPLAIN、返回空', async () => {
    const client = { query: vi.fn() };
    const r = await runGenerator({ client: client as any, viewConfigs: [], outDir: '/tmp/x' });
    expect(r.produced).toEqual([]);
    expect(r.explainFailures).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('有 viewConfig 但无 SQL 产出（P0 生成器未实现 Tier1）→ produced 仍空，不抛错', async () => {
    const client = { query: vi.fn() };
    const r = await runGenerator({
      client: client as any,
      viewConfigs: [{ view_name: 'report_brand_metric_gen', metrics: ['sale_amount'], dim_code: null, levels: [], target_metric_codes: [] }],
      outDir: '/tmp/x',
    });
    expect(r.produced).toEqual([]);
    expect(r.explainFailures).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/index.test.ts
```
Expected: FAIL（模块找不到）。

- [ ] **Step 3: 写实现（P0 stub：不产出 SQL，Tier1 逻辑放 P1）**

Create `services/semantic-generator/src/index.ts`：
```typescript
import 'dotenv/config';
import { Pool } from 'pg';
import { readRegistry } from './registry-reader.js';
import type { ViewConfig } from './types.js';

export interface GenResult {
  produced: string[];        // 产出的 .sql 文件名
  explainFailures: string[]; // EXPLAIN 失败的视图名
}

export interface GenOpts {
  client: { query: Function }; // pg PoolClient（测试可 mock）
  viewConfigs: ViewConfig[];
  outDir: string;
}

// P0：读 registry 验证可读，但 Tier1 生成逻辑未实现 → 不产出。
// P1 在此函数里加：按 viewConfig 生成 SQL → EXPLAIN → 写文件。
export async function runGenerator(opts: GenOpts): Promise<GenResult> {
  // 读 registry（验证连通 + L1 自洽由 DB 侧 validate_semantic_registry 保证）
  await readRegistry(opts.client as any);
  // P0：未实现 Tier1 emitter，故无产出
  return { produced: [], explainFailures: [] };
}

// CLI 入口：npm run gen-views
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ 缺 DATABASE_URL（见 .env.example）');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const client = await pool.connect();
    try {
      // P0：无 viewConfig（P1 起从 src/view-configs.ts 读）
      const r = await runGenerator({ client, viewConfigs: [], outDir: '../../database/generated' });
      console.log(`✅ 生成器完成：产出 ${r.produced.length} 个视图，EXPLAIN 失败 ${r.explainFailures.length} 个`);
      if (r.explainFailures.length) {
        console.error('  失败：', r.explainFailures.join(', '));
        process.exit(1);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// 只在直接运行时跑 main（被 import 进测试时不跑）
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
```

- [ ] **Step 4: 跑确认通过**

Run:
```bash
cd services/semantic-generator && npx vitest run src/__tests__/index.test.ts
```
Expected: PASS（2 个测试）。

- [ ] **Step 5: 跑全部测试确认无回归**

Run:
```bash
cd services/semantic-generator && npm test
```
Expected: 全部 PASS（registry-reader 3 + explain 2 + diff 3 + index 2 = 10）。

- [ ] **Step 6: 本地端到端空跑（连 dev PG）**

确保本地/dev postgres 已起、DATABASE_URL 指向它：
```bash
cd services/semantic-generator
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/insforge"
npm run gen-views
```
Expected: 输出 "✅ 生成器完成：产出 0 个视图，EXPLAIN 失败 0 个"，退出码 0。若连不上 PG，确认 dev postgres 端口/凭证（查 deploy/.env）。

- [ ] **Step 7: Commit**

```bash
git add services/semantic-generator/src/index.ts services/semantic-generator/src/__tests__/index.test.ts
git commit -m "feat(semantic): gen-views CLI 入口（P0 空跑）+ runGenerator 单测"
```

---

## Task 9: 架构文档更新（CLAUDE.md 铁律：先文档后代码）

**Files:**
- Modify: `docs/architecture.md`（§10 语义层段）

**Interfaces:**
- Produces: 架构文档反映 metric_registry 定位变更（文档型 → 构建期生成器输入）+ 新增视图生成器小节。

- [ ] **Step 1: 改 architecture.md §10 语义层段定位**

Find `docs/architecture.md` around line 1001（`**指标口径（088 语义层对齐...）`）。

在 `088 metric_registry 重构后业务视图需同步 patch...` 行之后，加新小节：

```markdown
### 10.x 视图生成器（构建期，2026-07-31）

spec：`docs/superpowers/specs/2026-07-31-semantic-layer-generator-wiring-design.md`。回归 07-22 初衷补建构建期生成器（**取代 07-29 的「文档型真相源」措辞**——metric_registry 从"文档型"升级为"构建期生成器输入"）。

- **形态**：Node/TS 脚本 `services/semantic-generator/`，读 `metric_registry`+`metric_sources`+`dimensions`，产出静态视图 SQL 到 `database/generated/`（入 git，可 review 可回滚）。
- **不做运行时动态引擎**（07-22 已 YAGNI，理由：RLS/security_invoker 兼容、可审计、避免外部重型服务）。
- **两档能力**：Tier1（base 聚合 + additive derived + 率重算 + cost脱敏 + target join）；Tier2（窗口派生：daily/remaining/profit_rate）。
- **三层校验**：L1 `validate_semantic_registry()`（静态，阻断部署）/ L2 生成时 EXPLAIN（阻断部署，失败不产文件）/ L3a rollup `_audit` 视图（运行期告警）/ L3b 双轨 SUM diff（阻断旧视图下线）。
- **部署**：migrate.sh 扫 `database/migrations/*.sql` + `database/generated/*.sql`；`scripts/deploy.sh` 迁移后 `docker compose restart postgrest` 刷 schema 缓存（视图变更生效）。
- **迁移次序**：配销比 → 品牌表 → 下钻表 → KPI 卡 → 类别表（双轨 diff=0 才切前端、下线旧视图）。
- **metric_definitions 定位调整**：保留作"目标存储 code 命名空间"（`target_metric_values.metric_code` 已存数据主键，不迁）；与 metric_registry 经 `metric_sources.source_filter` 里 `metric_code='xxx'` 链接。
```

- [ ] **Step 2: 改 07-29 region-breakdown-semantic-refactor 的措辞引用**

Find `docs/superpowers/specs/2026-07-29-region-breakdown-semantic-refactor.md` §2 首句 `metric_registry 是文档型真相源（无运行时引擎，视图照实现）`。

在该句后加一行：
```markdown
> **2026-07-31 更新**：本措辞被 `2026-07-31-semantic-layer-generator-wiring-design.md` 取代——metric_registry 升级为构建期生成器输入，视图由生成器产出（非手写照实现）。本 spec 的目标/口径修复仍有效，实现改走生成器。
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-07-29-region-breakdown-semantic-refactor.md
git commit -m "docs(arch): §10 视图生成器小节 + metric_registry 定位升级为构建期输入"
```

---

## Task 10: 端到端验证 + 收口提交

**Files:**
- 无新文件；验证 P0 全链路。

- [ ] **Step 1: 跑迁移 + L1**

```bash
bash scripts/migrate.sh
docker compose exec -T postgres psql -U postgres -d insforge -c "SELECT * FROM validate_semantic_registry();"
```
Expected: migrate 含 123 + generated 扫描（空）；L1 返 0 行。

- [ ] **Step 2: restart postgrest 验证生效**

```bash
docker compose restart postgrest
curl -s http://localhost:3000/  # 或 PostgREST 健康端点，查 deploy/.env 的 PostgREST 端口
```
Expected: postgrest 重启后 schema 缓存刷新，新注册的 metric_code 可查。

- [ ] **Step 3: 生成器全部测试**

```bash
cd services/semantic-generator && npm test
```
Expected: 10 个测试全 PASS。

- [ ] **Step 4: 生成器空跑连 dev PG**

```bash
cd services/semantic-generator
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/insforge"
npm run gen-views
```
Expected: "✅ 生成器完成：产出 0 个视图..."，退出码 0。

- [ ] **Step 5: 确认 git 状态干净**

```bash
git status
```
Expected: 所有改动已提交，working tree clean（除已被 ignore 的 node_modules）。

- [ ] **Step 6: 收口 commit（若前述 task 有遗漏未提交）**

```bash
git add -A
git commit -m "chore(semantic): P0 地基收口" || echo "无未提交改动"
```

---

## 自检（写计划后 fresh-eyes 复盘）

**Spec 覆盖**：spec §3（孤儿+target+source_filter）→ Task 1；spec §5.2（migrate 扫 generated + restart postgrest）→ Task 2+3；spec §2（generator 形态 + 产物入 git）→ Task 4-8；spec §5.1（L2 EXPLAIN/L3b diff）→ Task 6+7；spec §8（架构文档更新）→ Task 9。P0 = "L1 通过、生成器跑空产物" → Task 10 验证。P1-P5 不在本计划，后续各自成 plan。

**Placeholder 扫描**：无 TBD/TODO；每个代码步骤有完整代码。

**类型一致**：`parseMetric`/`parseSource`/`readRegistry`（Task 5）被 Task 8 `runGenerator` 调用，签名一致；`explainSql`（Task 6）、`sumDiff`（Task 7）签名与测试一致；`ViewConfig`（types.ts Task 4）被 Task 8 用，字段一致。

**P0 边界**：生成器不实现 Tier1 emitter（P1），故 Task 8 `runGenerator` stub 返回空产出——这是 P0 设计，非占位符。
