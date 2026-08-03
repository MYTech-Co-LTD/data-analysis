# 语义层数据准确性守护 P0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立语义层数据质量守护体系的 P0 核心——qa_logs 表、detail-sources/qa-checks 配置、D1/D2 去重守护、C2 视图断言（生成器 `_qa` 视图）、web 侧 QA 运行器与四类触发。

**Architecture:** 配置单一真相源在 `services/semantic-generator/`（detail-sources.json 注册明细自然键/聚合映射，qa-checks.json 声明视图断言）；生成器为每视图产 `_qa` 对账视图（PG 静态 SQL 入 `database/generated/`）；web 侧 `web/lib/qa-runner.ts` 编排 D1/D2/C2/C0 检查（duckdb HTTP + postgrest），写 qa_logs、企微告警；四类触发（每日 cron job / 采集后 hook / gen-views 后自动 / 手动 route）。P1 再收口 reconcile-check.js 三表查询与 C1 精确对齐（含 64188 客户拆分映射），P2 补全 viewAssertions。

**Tech Stack:** TypeScript/Node, Next.js API route + scheduler, DuckDB HTTP `/query`, PostgreSQL (postgrest + RPC), vitest (semantic-generator 与 web 各一套), tsx (CLI)

## Global Constraints

- **架构变更规则（CLAUDE.md）**：生成器改动属架构变更——必须先更新 `docs/architecture.md` §10.10 再改代码。Task 1 完成此步。
- **门店键铁律**：`branch_num` 跨账套重复，禁止单独 join/去重；D1/D2/C1 均以 `system_book_code` 参与聚合/分组，或按文件名路径提取品牌（`brand_expr`）。
- **迁移幂等模板**：所有 DDL 先 `DROP IF EXISTS` / `IF NOT EXISTS`；`qa_logs` 用 `CREATE TABLE IF NOT EXISTS`。
- **生成器铁律**：生成器代码禁业务字面量（`'3120'`/`'合计'` 等）——viewAssertions 的 `ref_sql` 是**配置数据**（qa-checks.json），不是生成器代码，允许含业务过滤条件；生成器只读配置不写口径。
- **外部数据字段**：本计划无新外部表字段，qa_logs 是自控表，`TEXT`/`NUMERIC`/`JSONB` 类型按模板。
- **JSON 配置路径**：web 与语义层共用 `detail-sources.json`/`qa-checks.json`（Next.js 支持相对路径 JSON import；semantic-generator 已开 `resolveJsonModule`）。
- **D1 自然键校验**：delivery/wholesale 的 natural_key 是业务键假设，上线首日须人工校准（跑 D1 采样重复行，确认 key 正确后再认定告警）。

---

### Task 1: 架构文档 §10.10 增加 L4 上游对账校验

**Files:**
- Modify: `docs/architecture.md`（§10.10 三层校验段落）

**Interfaces:**
- Produces: 架构文档记录「L4 上游对账（含 D 去重守护）」为语义层校验体系扩展，后续所有代码改动有据可依。

- [ ] **Step 1: 更新架构文档 §10.10「三层校验」段落**

在 `docs/architecture.md` §10.10 的「**三层校验**」行后追加一段（照 spec `docs/superpowers/specs/2026-08-03-data-accuracy-semantic-layer-design.md`）：

```markdown
- **L4 上游对账（2026-08-03 架构扩展）**：语义层配置成为全链路对账单一配置源。`detail-sources.json` 注册明细自然键/聚合表映射（D1 主键唯一性、D2 聚合 PK 重复、C1 明细↔聚合）；`qa-checks.json` 声明视图上游断言（C2 视图↔聚合表按 scope 过滤 SUM 一致），生成器为每视图产 `_qa` 对账视图（静态 SQL 入 database/generated，DROP+CREATE 幂等）。QA 运行器（web/lib/qa-runner.ts）编排 D1/D2/C1/C2/C3 并写 `qa_logs` + 企微告警。C0 源 API count↔明细 count 双向（库<源=缺漏、库>源×(1+ε)=疑重）。**去重守护不依赖 C1**——明细与聚合同时翻倍时 C1 对账相等 PASS，只有 D1 主键唯一性（COUNT(*) vs COUNT(DISTINCT 自然键)）能抓 transform 去重失败。改生成器/配置后 gen-views 自动跑 C2/C3/C4 防口径回归。
```

- [ ] **Step 2: 提交**

```bash
git add docs/architecture.md
git commit -m "docs(arch): §10.10 增加 L4 上游对账校验（D 去重守护 + C2 视图断言）"
```

---

### Task 2: 迁移——qa_logs 表 + qa_d2_dup_rows RPC

**Files:**
- Create: `database/migrations/153_qa_logs.sql`

**Interfaces:**
- Produces: `qa_logs` 表（qa_run_id/check_type/check_name/status/diff/detail JSONB/run_at）；RPC `qa_d2_dup_rows(p_table TEXT, p_keys TEXT[]) RETURNS TABLE(dup_key TEXT, cnt BIGINT)`（表名白名单校验后动态 GROUP BY HAVING COUNT>1）。

- [ ] **Step 1: 写迁移文件**

创建 `database/migrations/153_qa_logs.sql`：

```sql
-- 153_qa_logs.sql
-- qa_logs: 语义层数据质量守护对账结果日志（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
-- 幂等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / IF NOT EXISTS index

-- ===== qa_logs 表 =====
CREATE TABLE IF NOT EXISTS qa_logs (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT NOT NULL,
    trigger    TEXT NOT NULL,          -- 'cron' | 'collect' | 'deploy' | 'manual'
    check_type TEXT NOT NULL,          -- 'C0'..'C4' | 'D1' | 'D2'
    check_name TEXT NOT NULL,          -- 如 'D1:retail' / 'C2:report_brand_metric_gen'
    status     TEXT NOT NULL,          -- 'pass' | 'fail' | 'error'
    diff       NUMERIC,
    detail     JSONB,
    run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(run_id, check_type, check_name)
);
CREATE INDEX IF NOT EXISTS idx_qa_logs_run_at ON qa_logs(run_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_logs_status ON qa_logs(status);

GRANT SELECT, INSERT ON qa_logs TO anon;
GRANT SELECT, INSERT ON qa_logs TO authenticated;

-- ===== D2 聚合表 PK 重复检查 RPC =====
-- 表名白名单（防注入）; 动态 GROUP BY p_keys HAVING COUNT(*) > 1
CREATE OR REPLACE FUNCTION qa_d2_dup_rows(p_table TEXT, p_keys TEXT[])
RETURNS TABLE(dup_key TEXT, cnt BIGINT) AS $$
DECLARE
  key_list TEXT;
BEGIN
  IF p_table NOT IN (
    'report_daily_sales','report_daily_delivery','report_daily_wholesale',
    'report_daily_item_sales','report_daily_item_outbound','report_daily_wholesale_customer'
  ) THEN
    RAISE EXCEPTION 'qa_d2_dup_rows: forbidden table %', p_table;
  END IF;
  key_list := array_to_string(p_keys, ', ');
  RETURN QUERY EXECUTE format(
    'SELECT concat_ws(''|'', %s) AS dup_key, COUNT(*) AS cnt FROM %I GROUP BY %s HAVING COUNT(*) > 1',
    key_list, p_table, key_list
  );
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION qa_d2_dup_rows(TEXT, TEXT[]) TO anon;
GRANT EXECUTE ON FUNCTION qa_d2_dup_rows(TEXT, TEXT[]) TO authenticated;
```

- [ ] **Step 2: 本地验证迁移幂等 + RPC**

```bash
cd deploy && docker compose exec -T postgres psql -U postgres -d insforge -f /migrations/153_qa_logs.sql 2>&1 | tail -5
# 再跑一遍验证幂等（不报错）
cd deploy && docker compose exec -T postgres psql -U postgres -d insforge -f /migrations/153_qa_logs.sql 2>&1 | tail -3
# 验证 RPC
docker compose exec -T postgres psql -U postgres -d insforge -c "SELECT * FROM qa_d2_dup_rows('report_daily_sales', ARRAY['system_book_code','branch_num','biz_date']) LIMIT 5;"
```
Expected: 两次执行均无 ERROR；RPC 返回 0 行或 dup 行（正常数据应为 0 行）。

- [ ] **Step 3: 提交**

```bash
git add database/migrations/153_qa_logs.sql
git commit -m "feat(db): 迁移153 qa_logs表 + qa_d2_dup_rows RPC（D2聚合PK重复检查）"
```

---

### Task 3: 语义层配置——qa-types.ts + detail-sources.json + qa-checks.json + 校验测试

**Files:**
- Create: `services/semantic-generator/src/qa-types.ts`
- Create: `services/semantic-generator/src/detail-sources.json`
- Create: `services/semantic-generator/src/qa-checks.json`
- Test: `services/semantic-generator/__tests__/qa-config.test.ts`

**Interfaces:**
- Produces: `DetailSource[]`（detail-sources.json）、`ViewAssertion[]`（qa-checks.json）、`CheckType`/`QaTrigger` 类型。Task 4 生成器与 Task 6 web runner 均读取这两个 JSON（契约=JSON 结构，由 qa-types.ts 描述）。

- [ ] **Step 1: 写类型定义**

创建 `services/semantic-generator/src/qa-types.ts`：

```ts
// 语义层数据质量守护配置类型（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
// detail-sources.json / qa-checks.json 的结构契约

export type CheckType = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'D1' | 'D2';
export type QaTrigger = 'cron' | 'collect' | 'deploy' | 'manual';

/** 明细源注册：D1 主键唯一性 / D2 聚合PK重复 / C1 明细↔聚合 的配置来源 */
export interface DetailSource {
  name: string;                          // 'retail' | 'delivery' | 'wholesale'
  function_slug: string;                 // 对应采集 function（C0 参数查找用）
  glob: string;                          // 严格 all.parquet glob
  natural_key: string[];                 // D1 用（业务键，禁用 id）
  agg_table: string;                     // C1/D2 用
  agg_key: string[];                     // D2 用（聚合表 PK 列）
  agg_metric: { detail: string; agg: string }[];  // C1 用（明细列→聚合列）
  brand_expr: string;                    // 品牌提取表达式（duckdb，引 filename）
  detail_date_expr: string;              // 明细日期 → YYYYMMDD 表达式
  api_count?: { fn: string; dates_iso: boolean };  // C0 用（web 侧映射）
  tolerance: number;                     // C1 金额容差（元）
}

/** 视图上游断言：C2 用（独立重算，不经生成器 AST，保证与视图口径相互独立） */
export interface ViewAssertion {
  view: string;                          // 视图名（report_*_gen）
  metric: string;                        // 视图输出列名（含 alias）
  view_sum_filter: string;               // 视图 SUM 过滤（排除合计行等）
  ref_sql: string;                       // 独立重算，返回单值 SUM
  tolerance: number;
}
```

- [ ] **Step 2: 写 detail-sources.json**

创建 `services/semantic-generator/src/detail-sources.json`（品牌提取与日期提取照 `scripts/reconcile-check.js` 实测口径）：

```json
[
  {
    "name": "retail",
    "function_slug": "collect-lemeng",
    "glob": "s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet",
    "natural_key": ["branch_num", "order_no", "order_detail_num"],
    "agg_table": "report_daily_sales",
    "agg_key": ["system_book_code", "branch_num", "biz_date"],
    "agg_metric": [
      { "detail": "sale_money", "agg": "total_sale" },
      { "detail": "profit", "agg": "total_profit" }
    ],
    "brand_expr": "regexp_extract(filename,'retail_detail/([0-9]+)/',1)",
    "detail_date_expr": "replace(order_detail_bizday,'-','')",
    "api_count": { "fn": "countRetailApi", "dates_iso": true },
    "tolerance": 0.01
  },
  {
    "name": "delivery",
    "function_slug": "collect-delivery",
    "glob": "s3://lemeng-datasource/lemeng/transfer_detail/*/*/all.parquet",
    "natural_key": ["pos_order_num", "item_num", "response_branch_num"],
    "agg_table": "report_daily_delivery",
    "agg_key": ["system_book_code", "branch_num", "biz_date"],
    "agg_metric": [
      { "detail": "out_money", "agg": "out_money" },
      { "detail": "profit_money", "agg": "profit_money" }
    ],
    "brand_expr": "regexp_extract(filename,'transfer_detail/([0-9]+)/',1)",
    "detail_date_expr": "substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2)",
    "api_count": { "fn": "countDeliveryApi", "dates_iso": false },
    "tolerance": 0.01
  },
  {
    "name": "wholesale",
    "function_slug": "collect-wholesale",
    "glob": "s3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet",
    "natural_key": ["pos_order_num", "item_num", "client_code"],
    "agg_table": "report_daily_wholesale",
    "agg_key": ["system_book_code", "branch_num", "biz_date"],
    "agg_metric": [
      { "detail": "wholesale_money", "agg": "wholesale_money" },
      { "detail": "wholesale_profit", "agg": "wholesale_profit" }
    ],
    "brand_expr": "regexp_extract(filename,'wholesale_detail/([0-9]+)/',1)",
    "detail_date_expr": "substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2)",
    "api_count": { "fn": "countWholesaleApi", "dates_iso": false },
    "tolerance": 0.01
  }
]
```

- [ ] **Step 3: 写 qa-checks.json（C2 断言，首批 1 视图 1 指标作模式）**

创建 `services/semantic-generator/src/qa-checks.json`（ref_sql 独立重算，与视图 tgt scope 一致：total 目标窗口 + 考核战区；排除合计行）：

```json
[
  {
    "view": "report_brand_metric_gen",
    "metric": "sale_amount",
    "view_sum_filter": "system_book_code <> '合计'",
    "ref_sql": "SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active', 'closed') WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))",
    "tolerance": 0.01
  }
]
```

- [ ] **Step 4: 写配置校验测试**

创建 `services/semantic-generator/__tests__/qa-config.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import detailSources from '../src/detail-sources.json';
import qaChecks from '../src/qa-checks.json';
import type { DetailSource, ViewAssertion } from '../src/qa-types.js';

function isDetailSource(x: any): x is DetailSource {
  return x && typeof x.name === 'string' && Array.isArray(x.natural_key)
    && x.natural_key.length > 0 && typeof x.glob === 'string'
    && x.glob.endsWith('all.parquet') && typeof x.agg_table === 'string'
    && Array.isArray(x.agg_key) && Array.isArray(x.agg_metric)
    && typeof x.brand_expr === 'string' && typeof x.detail_date_expr === 'string'
    && typeof x.tolerance === 'number';
}

describe('qa 配置', () => {
  it('detail-sources: 三张明细全注册且结构合法', () => {
    expect(detailSources).toHaveLength(3);
    expect(detailSources.every(isDetailSource)).toBe(true);
    expect(detailSources.map((s) => s.name).sort()).toEqual(['delivery', 'retail', 'wholesale']);
  });
  it('detail-sources: natural_key 禁含 id（lemeng 分页每次重新生成 id 致 DISTINCT * 失效）', () => {
    for (const s of detailSources) {
      expect(s.natural_key).not.toContain('id');
    }
  });
  it('detail-sources: 聚合列能对上真实聚合表列名（手滑写错会在 C1 对账暴露）', () => {
    const aggCols: Record<string, string[]> = {
      report_daily_sales: ['system_book_code', 'branch_num', 'biz_date', 'total_sale', 'total_profit'],
      report_daily_delivery: ['system_book_code', 'branch_num', 'biz_date', 'out_money', 'profit_money'],
      report_daily_wholesale: ['system_book_code', 'branch_num', 'biz_date', 'wholesale_money', 'wholesale_profit'],
    };
    for (const s of detailSources) {
      const cols = aggCols[s.agg_table];
      expect(cols, `${s.name} 缺聚合表列清单`).toBeDefined();
      for (const k of s.agg_key) expect(cols).toContain(k);
      for (const m of s.agg_metric) expect(cols).toContain(m.agg);
    }
  });
  it('qa-checks: 结构合法，ref_sql 非空', () => {
    for (const c of qaChecks as ViewAssertion[]) {
      expect(typeof c.view).toBe('string');
      expect(typeof c.metric).toBe('string');
      expect(typeof c.view_sum_filter).toBe('string');
      expect(c.ref_sql.trim().length).toBeGreaterThan(10);
      expect(c.ref_sql.startsWith('SELECT')).toBe(true);
      expect(typeof c.tolerance).toBe('number');
    }
  });
});
```

- [ ] **Step 5: 跑测试**

```bash
cd services/semantic-generator && npx vitest run __tests__/qa-config.test.ts
```
Expected: 4 tests pass。

- [ ] **Step 6: 提交**

```bash
git add services/semantic-generator/src/qa-types.ts services/semantic-generator/src/detail-sources.json services/semantic-generator/src/qa-checks.json services/semantic-generator/__tests__/qa-config.test.ts
git commit -m "feat(semantic): qa配置--detail-sources自然键注册 + qa-checks视图断言（L4配置真相源）"
```

---

### Task 4: 生成器产 `_qa` 对账视图（C2 静态产物）

**Files:**
- Create: `services/semantic-generator/src/generators/qa.ts`
- Modify: `services/semantic-generator/src/index.ts`（runGenerator 接入）
- Test: `services/semantic-generator/__tests__/qa-view.test.ts`

**Interfaces:**
- Consumes: `qa-checks.json`（`ViewAssertion[]`）、`ViewConfig`（index.ts 遍历）
- Produces: `generateQaView(assertions: ViewAssertion[]): string`——返回 `DROP VIEW IF EXISTS ${view}_qa; CREATE VIEW ${view}_qa AS ...`；`runGenerator` 对每个有断言的视图产 `${view}_qa.sql` 到 `database/generated/`（与视图同目录，`_qa` 按字典序排在视图之后，migrate.sh 后应用）。

- [ ] **Step 1: 写生成函数**

创建 `services/semantic-generator/src/generators/qa.ts`：

```ts
// services/semantic-generator/src/generators/qa.ts
// C2 视图上游断言对账视图（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
// 产出 ${view}_qa：一行一个断言，列 = (metric, view_sum, ref_sum, diff)
// view_sum 从视图按 view_sum_filter 独立 SUM；ref_sum 用 qa-checks 声明的独立重算 SQL。
// 静态产物入 database/generated，DROP+CREATE 幂等（与 _audit 同模式）。
import type { ViewAssertion } from '../qa-types.js';

export function generateQaView(assertions: ViewAssertion[]): string {
  if (assertions.length === 0) return '';
  const view = assertions[0].view;
  const rows = assertions
    .map((a) => {
      const sumCol = a.metric;
      return `  SELECT '${a.metric}' AS metric,
    COALESCE((SELECT SUM(${sumCol}) FROM ${view} WHERE ${a.view_sum_filter}), 0) AS view_sum,
    COALESCE((${a.ref_sql}), 0) AS ref_sum`;
    })
    .join('\n  UNION ALL\n');

  return `DROP VIEW IF EXISTS ${view}_qa;
CREATE VIEW ${view}_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
${rows}
) t;
`;
}
```

- [ ] **Step 2: 写契约测试**

创建 `services/semantic-generator/__tests__/qa-view.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { generateQaView } from '../src/generators/qa.js';
import qaChecks from '../src/qa-checks.json';
import type { ViewAssertion } from '../src/qa-types.js';

describe('generateQaView', () => {
  const assertions = qaChecks as ViewAssertion[];

  it('对每视图产出 DROP+CREATE 幂等视图', () => {
    const sql = generateQaView(assertions);
    expect(sql).toContain(`DROP VIEW IF EXISTS ${assertions[0].view}_qa;`);
    expect(sql).toContain(`CREATE VIEW ${assertions[0].view}_qa AS`);
  });

  it('每断言一行，含 view_sum（过滤合计行）与 ref_sum', () => {
    const sql = generateQaView(assertions);
    for (const a of assertions) {
      expect(sql).toContain(`SUM(${a.metric}) FROM ${a.view} WHERE ${a.view_sum_filter}`);
      expect(sql).toContain(`SELECT COALESCE(SUM(s.total_sale), 0)`); // ref_sql 原文
    }
  });

  it('空断言返回空串', () => {
    expect(generateQaView([])).toBe('');
  });
});
```

- [ ] **Step 3: 接入 runGenerator（index.ts）**

修改 `services/semantic-generator/src/index.ts`：

- 顶部 import qa-checks 与 qa 生成器：

```ts
import { generateQaView } from './generators/qa.js';
import qaChecks from './qa-checks.json';
import type { ViewAssertion } from './qa-types.js';
```

- `runGenerator` 在写视图文件后追加写 `_qa` 文件（当前 `for` 循环末尾，`writeFileSync(file, sql + '\n')` 之后）：

```ts
      // 写文件
      const file = join(opts.outDir, `${config.view_name}.sql`);
      writeFileSync(file, sql + '\n');
      produced.push(config.view_name);

      // L4 C2：该视图有断言则产 ${view}_qa 对账视图（静态 SQL，migrate 幂等应用）
      const viewAssertions = (qaChecks as ViewAssertion[]).filter((a) => a.view === config.view_name);
      if (viewAssertions.length) {
        const qaSql = generateQaView(viewAssertions);
        const qaFile = join(opts.outDir, `${config.view_name}_qa.sql`);
        writeFileSync(qaFile, qaSql + '\n');
      }
```

- `main()` 的 `viewConfigs` 数组加回被变量解构遗漏的视图？不需要（保持原状）；`runGenerator` 需在 `runGenerator` 中访问 qa-checks（模块级 import 即可）。

- [ ] **Step 4: 跑契约测试**

```bash
cd services/semantic-generator && npx vitest run __tests__/qa-view.test.ts
```
Expected: 3 tests pass。

- [ ] **Step 5: 本地 gen-views 验证产出 _qa 文件**

```bash
cd services/semantic-generator && DATABASE_URL=$(cat .env | grep DATABASE_URL | cut -d= -f2-) npm run gen-views 2>&1 | tail -5
ls -la ../../database/generated/report_brand_metric_gen_qa.sql
head -20 ../../database/generated/report_brand_metric_gen_qa.sql
```
Expected: 出现 `report_brand_metric_gen_qa.sql`，内容含 `CREATE VIEW report_brand_metric_gen_qa AS` 与 ref_sql。若 EXPLAIN 失败会列在输出（Task 5 处理断言执行）。

- [ ] **Step 6: 提交**

```bash
git add services/semantic-generator/src/generators/qa.ts services/semantic-generator/src/index.ts services/semantic-generator/__tests__/qa-view.test.ts database/generated/report_brand_metric_gen_qa.sql
git commit -m "feat(semantic): 生成器产 _qa 对账视图（C2 视图↔聚合表断言，静态产物）"
```

---

### Task 5: gen-views 后自动跑 C2/C3 断言（部署/生成后触发）

**Files:**
- Modify: `services/semantic-generator/src/index.ts`

**Interfaces:**
- Consumes: `runGenerator` 已产出的 `${view}_qa` 视图（Task 4）
- Produces: `runGenerator` 返回 `{ produced, explainFailures, assertionFailures }`；断言 diff>tolerance 计入 `assertionFailures`，main() 存在任一失败时 `process.exit(1)`（阻断部署）。

- [ ] **Step 1: runGenerator 加 C2 断言执行**

修改 `services/semantic-generator/src/index.ts`：

- `GenResult` 接口加字段：

```ts
export interface GenResult {
  produced: string[];
  explainFailures: string[];
  assertionFailures: string[];   // L4 C2：视图↔聚合对账断言 diff>容差
}
```

- 初始化加 `const assertionFailures: string[] = [];`，返回值 `{ produced, explainFailures, assertionFailures }`。

- 在 Task 4 写的 `_qa` 文件块后追加断言执行（gen 后自动跑，diff>容差计入失败）：

```ts
      // L4 C2：gen 后立即跑断言（视图↔聚合表 SUM 对账），防上线即回归
      if (viewAssertions.length) {
        try {
          // 先建 _qa 视图（runGenerator 顶部只建了主视图，_qa 未入 DB）
          await opts.client.query(generateQaView(viewAssertions));
          const qaRows = await opts.client.query(
            `SELECT metric, view_sum, ref_sum, diff FROM ${config.view_name}_qa WHERE ABS(diff) > $1`,
            [0.01],
          );
          for (const row of qaRows.rows) {
            assertionFailures.push(
              `${config.view_name}.${row.metric}: 视图 ${row.view_sum} vs 上游 ${row.ref_sum} (diff ${row.diff})`,
            );
          }
        } catch (e) {
          assertionFailures.push(`${config.view_name}_qa 断言查询失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
```

- [ ] **Step 2: main() 输出断言失败并阻断**

修改 `services/semantic-generator/src/index.ts` 的 `main()` 中 `console.log` 与退出逻辑：

```ts
      const r = await runGenerator({ client, viewConfigs: [...], outDir: '../../database/generated' });
      console.log(`✅ 生成器完成：产出 ${r.produced.length} 个视图，EXPLAIN 失败 ${r.explainFailures.length} 个，断言失败 ${r.assertionFailures.length} 个`);
      if (r.produced.length) console.log('  产出:', r.produced.join(', '));
      const allFails = [...r.explainFailures, ...r.assertionFailures];
      if (allFails.length) {
        console.error('  失败:');
        allFails.forEach((f) => console.error('   -', f));
        process.exit(1);
      }
```

（保持 `viewConfigs` 数组为现有 8 个视图配置不变。）

- [ ] **Step 3: 本地验证 gen-views 断言跑通**

```bash
cd services/semantic-generator && DATABASE_URL=$(cat .env | grep DATABASE_URL | cut -d= -f2-) npm run gen-views 2>&1 | tail -8
```
Expected: 输出 `断言失败 0 个`（若 ref_sql 口径与视图不一致会列失败并 exit 1，据此修正 qa-checks.json 的 ref_sql，直到 0 失败）。

- [ ] **Step 4: 提交**

```bash
git add services/semantic-generator/src/index.ts
git commit -m "feat(semantic): gen-views 后自动跑 C2 断言（diff>容差阻断部署）"
```

---

### Task 6: web D1/D2 检查构建器 + duck helper + 单测

**Files:**
- Create: `web/lib/qa/types.ts`
- Create: `web/lib/qa/duck.ts`
- Create: `web/lib/qa/d1.ts`
- Create: `web/lib/qa/d2.ts`
- Test: `web/lib/qa/__tests__/d1.test.ts`、`web/lib/qa/__tests__/d2.test.ts`

**Interfaces:**
- Consumes: `detail-sources.json`（web 相对路径 import）
- Produces:
  - `duckQuery(duckUrl: string, apiKey: string, sql: string): Promise<Record<string, unknown>[]>`（POST `/query`，返 `j.data`，失败 throw）
  - `buildD1Sql(src: DetailSource, dateFrom: string, dateTo: string): string`
  - `runD1(duck, src, dateFrom, dateTo): Promise<{ dupRows: ...; totalRows: number; dupRatio: number }>`
  - `buildD2Sql(aggTable: string, aggKey: string[]): string` + `runD2(db, src): Promise<...>`（经 RPC `qa_d2_dup_rows`）

- [ ] **Step 1: 写类型**

创建 `web/lib/qa/types.ts`（镜像语义层 qa-types.ts，避免跨包 TS import；JSON 结构即契约）：

```ts
export type CheckType = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'D1' | 'D2';
export type QaTrigger = 'cron' | 'collect' | 'deploy' | 'manual';

export interface DetailSource {
  name: string;
  function_slug: string;
  glob: string;
  natural_key: string[];
  agg_table: string;
  agg_key: string[];
  agg_metric: { detail: string; agg: string }[];
  brand_expr: string;
  detail_date_expr: string;
  api_count?: { fn: string; dates_iso: boolean };
  tolerance: number;
}

export interface ViewAssertion {
  view: string;
  metric: string;
  view_sum_filter: string;
  ref_sql: string;
  tolerance: number;
}

export interface CheckResult {
  run_id: string;
  trigger: QaTrigger;
  check_type: CheckType;
  check_name: string;
  status: 'pass' | 'fail' | 'error';
  diff: number | null;
  detail: unknown[] | null;
}
```

- [ ] **Step 2: 写 duck helper**

创建 `web/lib/qa/duck.ts`：

```ts
// web/lib/qa/duck.ts
// DuckDB HTTP /query 执行器（照 scheduler duckdbParquetCount 模式）
export async function duckQuery(
  duckUrl: string,
  apiKey: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${duckUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': apiKey },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('duckdb: ' + j.error);
  return j.data;
}
```

- [ ] **Step 3: 写 D1 构建器 + 运行**

创建 `web/lib/qa/d1.ts`：

```ts
// web/lib/qa/d1.ts
// D1 明细主键唯一性守护：COUNT(*) vs COUNT(DISTINCT 自然键)
// 抓 transform 去重失败（明细翻倍）——C1 明细↔聚合对账对"双端同翻"是盲的，必须 D1 独立。
import type { DetailSource } from './types';
import { duckQuery } from './duck';

export function buildD1Sql(src: DetailSource, dateFrom: string, dateTo: string): string {
  const keyExpr = src.natural_key.map((k) => `CAST(${k} AS VARCHAR)`).join(", '\\x1F', ");
  return `SELECT ${src.brand_expr} AS system_book_code,
  ${src.detail_date_expr} AS bizday,
  COUNT(*) AS total_rows,
  COUNT(DISTINCT CONCAT_WS('\\x1F', ${keyExpr})) AS distinct_rows
FROM read_parquet('${src.glob}', filename=true)
WHERE ${src.detail_date_expr} BETWEEN '${dateFrom}' AND '${dateTo}'
GROUP BY 1, 2
HAVING COUNT(*) > COUNT(DISTINCT CONCAT_WS('\\x1F', ${keyExpr}))`;
}

export interface D1DupRow {
  system_book_code: string;
  bizday: string;
  total_rows: number;
  distinct_rows: number;
}

export async function runD1(
  duck: (sql: string) => Promise<Record<string, unknown>[]>,
  src: DetailSource,
  dateFrom: string,
  dateTo: string,
): Promise<{ dupRows: D1DupRow[]; query: string }> {
  const query = buildD1Sql(src, dateFrom, dateTo);
  const rows = (await duck(query)) as D1DupRow[];
  return { dupRows: rows, query };
}

export { duckQuery };
```

- [ ] **Step 4: 写 D2 构建器 + 运行（经 RPC）**

创建 `web/lib/qa/d2.ts`：

```ts
// web/lib/qa/d2.ts
// D2 聚合表 PK 重复守护：经 RPC qa_d2_dup_rows(p_table, p_keys) 查 PK 分组 COUNT>1 行。
import type { DetailSource } from './types';

export interface D2DupRow {
  dup_key: string;
  cnt: number;
}

// db: postgrest 客户端（InsForge SDK），rpc 调用
export async function runD2(
  db: { rpc: (fn: string, body: Record<string, unknown>) => Promise<{ data?: unknown[]; error?: unknown }> },
  src: DetailSource,
): Promise<{ dupRows: D2DupRow[] }> {
  const res = await db.rpc('qa_d2_dup_rows', { p_table: src.agg_table, p_keys: src.agg_key });
  if (res.error) throw new Error('qa_d2_dup_rows: ' + JSON.stringify(res.error));
  return { dupRows: (res.data ?? []) as D2DupRow[] };
}
```

- [ ] **Step 5: 写 D1/D2 单测**

创建 `web/lib/qa/__tests__/d1.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildD1Sql } from '../d1';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';

describe('buildD1Sql', () => {
  const retail = detailSources.find((s) => s.name === 'retail')!;
  const sql = buildD1Sql(retail, '20260701', '20260731');

  it('引用 glob 与日期过滤', () => {
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet'");
    expect(sql).toContain("BETWEEN '20260701' AND '20260731'");
  });
  it('自然键含分支+单号+行号，不含 id', () => {
    expect(sql).toContain('order_no');
    expect(sql).toContain('order_detail_num');
    expect(sql).not.toContain('COUNT(DISTINCT id');
  });
  it('HAVING 抓重复（count>distinct）', () => {
    expect(sql).toMatch(/HAVING COUNT\(\*\) > COUNT\(DISTINCT CONCAT_WS/);
  });
});
```

创建 `web/lib/qa/__tests__/d2.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { runD2 } from '../d2';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';

describe('runD2', () => {
  it('经 RPC 传 p_table 与 p_keys（聚合键）', async () => {
    const retail = detailSources.find((s) => s.name === 'retail')!;
    let called = null as any;
    const db = { rpc: async (fn: string, body: any) => { called = { fn, body }; return { data: [] }; } } as any;
    const { dupRows } = await runD2(db, retail);
    expect(called.fn).toBe('qa_d2_dup_rows');
    expect(called.body.p_table).toBe('report_daily_sales');
    expect(called.body.p_keys).toEqual(['system_book_code', 'branch_num', 'biz_date']);
    expect(dupRows).toEqual([]);
  });
});
```

- [ ] **Step 6: 跑测试**

```bash
cd web && npx vitest run lib/qa/__tests__/d1.test.ts lib/qa/__tests__/d2.test.ts
```
Expected: 5 tests pass。若 `resolveJsonModule` 报错，在 `web/tsconfig.json` 补 `"resolveJsonModule": true`（Next 默认开启，通常无需）。

- [ ] **Step 7: 提交**

```bash
git add web/lib/qa/types.ts web/lib/qa/duck.ts web/lib/qa/d1.ts web/lib/qa/d2.ts web/lib/qa/__tests__/d1.test.ts web/lib/qa/__tests__/d2.test.ts
git commit -m "feat(web): D1明细主键唯一性 + D2聚合PK重复检查构建器"
```

---

### Task 7: web QA 运行器核心（D1/D2/C2 编排 + qa_logs 写）

**Files:**
- Create: `web/lib/qa-runner.ts`
- Test: `web/lib/__tests__/qa-runner.test.ts`

**Interfaces:**
- Consumes: `runD1`/`runD2`（Task 6）、`detail-sources.json`、`qa-checks.json`、postgrest 客户端 `db`（注入口）、duck 执行器 `duck`（注入）
- Produces: `runQaChecks(opts): Promise<CheckResult[]>`——签名如下，Task 8/9/10 复用：

```ts
export interface RunQaOpts {
  runId: string;
  trigger: QaTrigger;
  db: { rpc(fn: string, body: Record<string, unknown>): Promise<{ data?: unknown[]; error?: unknown }>;
        from(t: string): { select(cols?: string): Promise<{ data?: unknown[]; error?: unknown }>;
                           insert(rows: unknown[]): Promise<{ data?: unknown[]; error?: unknown }> } };
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  checks?: string[];              // 过滤，如 ['D1:retail','C2:report_brand_metric_gen']；缺省=全部
  dateFrom?: string; dateTo?: string;  // 缺省最近 7 天（compact YYYYMMDD）
}
```

- [ ] **Step 1: 写运行器核心**

创建 `web/lib/qa-runner.ts`：

```ts
// web/lib/qa-runner.ts
// 语义层数据质量守护 QA 运行器（L4）：编排 D1/D2/C2 检查，写 qa_logs。
// 依赖注入 db(postgrest)/duck(duckdb HTTP)，web route 与 scheduler 共用。
import { runD1 } from './qa/d1';
import { runD2 } from './qa/d2';
import detailSources from '../../services/semantic-generator/src/detail-sources.json';
import qaChecks from '../../services/semantic-generator/src/qa-checks.json';
import type { DetailSource, ViewAssertion, CheckResult, CheckType, QaTrigger } from './qa/types';

const DUCK_TOLERANCE = 0.01;

function compactDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export interface RunQaOpts {
  runId: string;
  trigger: QaTrigger;
  db: {
    rpc(fn: string, body: Record<string, unknown>): Promise<{ data?: unknown[]; error?: unknown }>;
    from(t: string): {
      select(cols?: string): Promise<{ data?: unknown[]; error?: unknown }>;
      insert(rows: unknown[]): Promise<{ data?: unknown[]; error?: unknown }>;
    };
  };
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  checks?: string[];
  dateFrom?: string;
  dateTo?: string;
}

function want(checks: string[] | undefined, kind: CheckType, name: string): boolean {
  if (!checks || checks.length === 0) return true;
  const key = `${kind}:${name}`;
  return checks.includes(key);
}

export async function runQaChecks(opts: RunQaOpts): Promise<CheckResult[]> {
  const dateFrom = opts.dateFrom ?? compactDaysAgo(6);
  const dateTo = opts.dateTo ?? compactDaysAgo(0);
  const results: CheckResult[] = [];

  const record = async (check_type: CheckType, check_name: string, status: CheckResult['status'], diff: number | null, detail: unknown[] | null) => {
    const row: CheckResult = { run_id: opts.runId, trigger: opts.trigger, check_type, check_name, status, diff, detail };
    results.push(row);
    const ins = await opts.db.from('qa_logs').insert([row]);
    if (ins.error) console.error('[qa-runner] qa_logs 写入失败:', JSON.stringify(ins.error));
  };

  // D1 明细主键唯一性
  for (const src of detailSources as DetailSource[]) {
    if (!want(opts.checks, 'D1', src.name)) continue;
    try {
      const { dupRows } = await runD1(opts.duck, src, dateFrom, dateTo);
      if (dupRows.length) {
        await record('D1', src.name, 'fail', dupRows.length, dupRows.slice(0, 20));
      } else {
        await record('D1', src.name, 'pass', 0, null);
      }
    } catch (e) {
      await record('D1', src.name, 'error', null, [{ error: String(e instanceof Error ? e.message : e) }]);
    }
  }

  // D2 聚合 PK 重复
  for (const src of detailSources as DetailSource[]) {
    if (!want(opts.checks, 'D2', src.name)) continue;
    try {
      const { dupRows } = await runD2(opts.db, src);
      if (dupRows.length) {
        await record('D2', src.name, 'fail', dupRows.length, dupRows.slice(0, 20));
      } else {
        await record('D2', src.name, 'pass', 0, null);
      }
    } catch (e) {
      await record('D2', src.name, 'error', null, [{ error: String(e instanceof Error ? e.message : e) }]);
    }
  }

  // C2 视图↔聚合表断言（查生成的 _qa 视图）
  for (const a of qaChecks as ViewAssertion[]) {
    if (!want(opts.checks, 'C2', a.view)) continue;
    try {
      const res = await opts.db.from(`${a.view}_qa`).select('metric,view_sum,ref_sum,diff');
      const rows = (res.data ?? []) as { metric: string; view_sum: number; ref_sum: number; diff: number }[];
      const bad = rows.filter((r) => Math.abs(r.diff) > a.tolerance);
      if (bad.length) {
        await record('C2', a.view, 'fail', bad.length, bad.slice(0, 20));
      } else {
        await record('C2', a.view, 'pass', 0, null);
      }
    } catch (e) {
      await record('C2', a.view, 'error', null, [{ error: String(e instanceof Error ? e.message : e) }]);
    }
  }

  return results;
}

export const qaDuckTolerance = DUCK_TOLERANCE;
```

- [ ] **Step 2: 写运行器单测（mock duck/db）**

创建 `web/lib/__tests__/qa-runner.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { runQaChecks } from '../qa-runner';
import detailSources from '../../../services/semantic-generator/src/detail-sources.json';

function makeDb(overrides: Record<string, unknown> = {}) {
  const inserted: unknown[] = [];
  const db = {
    rpc: vi.fn(async () => ({ data: [] })),
    from: vi.fn((t: string) => ({
      select: vi.fn(async () => ({ data: [], error: null })),
      insert: vi.fn(async (rows: unknown[]) => { inserted.push(...(rows as unknown[])); return { data: rows, error: null }; }),
    })),
    _inserted: inserted,
    ...overrides,
  };
  return db as any;
}

describe('runQaChecks', () => {
  it('D1 全部通过时记 pass，写 qa_logs', async () => {
    const db = makeDb();
    const duck = vi.fn(async () => []);
    const results = await runQaChecks({ runId: 'test-1', trigger: 'cron', db, duck });
    expect(results.filter((r) => r.check_type === 'D1' && r.status === 'pass').length).toBe(3);
    expect(results.filter((r) => r.check_type === 'D2' && r.status === 'pass').length).toBe(3);
    expect(db._inserted.length).toBeGreaterThan(0);
  });

  it('D1 有重复行记 fail 且 diff=重复行数', async () => {
    const retail = detailSources.find((s) => s.name === 'retail')!;
    const db = makeDb();
    const duck = vi.fn(async () => {
      if (String(vi.fn.getMockName ? '':'')) {}
      return [];
    });
    // duck 返回零售重复行（仅当 sql 含 retail）
    duck.mockImplementation(async (sql: string) =>
      sql.includes('retail_detail')
        ? [{ system_book_code: '3120', bizday: '20260728', total_rows: 120, distinct_rows: 2 }]
        : []);
    const results = await runQaChecks({ runId: 'test-2', trigger: 'manual', db, duck, checks: ['D1:retail'] });
    const d1 = results.find((r) => r.check_type === 'D1');
    expect(d1?.status).toBe('fail');
    expect(d1?.diff).toBe(1);
  });

  it('checks 过滤生效', async () => {
    const db = makeDb();
    const duck = vi.fn(async () => []);
    const results = await runQaChecks({ runId: 'test-3', trigger: 'cron', db, duck, checks: ['D2:retail'] });
    expect(results.length).toBe(1);
    expect(results[0].check_type).toBe('D2');
    expect(results[0].check_name).toBe('retail');
  });
});
```

- [ ] **Step 3: 跑测试**

```bash
cd web && npx vitest run lib/__tests__/qa-runner.test.ts
```
Expected: 3 tests pass。

- [ ] **Step 4: 提交**

```bash
git add web/lib/qa-runner.ts web/lib/__tests__/qa-runner.test.ts
git commit -m "feat(web): QA运行器核心--D1/D2/C2编排+qa_logs写入"
```

---

### Task 8: C0 双向 count + /api/admin/qa-run route

**Files:**
- Create: `web/lib/qa/c0.ts`
- Create: `web/app/api/admin/qa-run/route.ts`

**Interfaces:**
- Consumes: `runQaChecks`（Task 7）、`lib/collect` 的 `countRetailApi`/`countDeliveryApi`/`countWholesaleApi`、InsForge SDK `createClient`、`notifyWecom`
- Produces: C0 检查（按日×品牌双向：库<源×(1-0.1)=缺漏、库>源×(1+0.1)=疑重）并入 runQaChecks 结果；`POST /api/admin/qa-run`（requireAdmin 鉴权，支持 `?check=` 单查 + `?trigger=` 触发源 + 企微告警）。

- [ ] **Step 1: 写 C0 构建器**

创建 `web/lib/qa/c0.ts`：

```ts
// web/lib/qa/c0.ts
// C0 源API count ↔ 明细 parquet count（按日×品牌，双向）
// 库<源×(1-ε) = 缺漏；库>源×(1+ε) = 疑重（补上单向周对账抓不到重复的盲区）
import type { DetailSource, CheckResult } from './types';

export const C0_EPSILON = 0.1;

export type ApiCountFn = (authToken: string, ...args: any[]) => Promise<number>;

export interface C0Row {
  source: string;
  day: string;
  api: number;
  lib: number;
  verdict: 'ok' | 'missing' | 'dup-suspect' | 'error';
}

export async function runC0(
  src: DetailSource,
  day: string,
  apiCount: number,        // 调用方已按源取数
  libCount: number,
): Promise<CheckResult> {
  const status: CheckResult['status'] = apiCount < 0 ? 'error' : 'pass';
  let diff: number | null = null;
  let detail: unknown[] | null = null;
  if (apiCount >= 0) {
    const low = Math.floor(apiCount * (1 - C0_EPSILON));
    const high = Math.ceil(apiCount * (1 + C0_EPSILON));
    if (libCount < low) { status = 'fail'; detail = [{ day, api: apiCount, lib: libCount, verdict: 'missing' }]; diff = libCount - apiCount; }
    else if (libCount > high) { status = 'fail'; detail = [{ day, api: apiCount, lib: libCount, verdict: 'dup-suspect' }]; diff = libCount - apiCount; }
    else { diff = libCount - apiCount; }
  } else {
    detail = [{ day, api: apiCount, lib: libCount, verdict: 'error' }];
  }
  return { run_id: '', trigger: 'manual', check_type: 'C0', check_name: src.name, status, diff, detail };
}
```

- [ ] **Step 2: 写 route**

创建 `web/app/api/admin/qa-run/route.ts`：

```ts
// web/app/api/admin/qa-run/route.ts
// 手动/外部触发 QA 运行器（D1/D2/C2 + C0 双向 count），记 qa_logs + 企微告警
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { requireAdmin } from '@/lib/admin-api-auth';
import { runQaChecks } from '@/lib/qa-runner';
import { runC0 } from '@/lib/qa/c0';
import { duckQuery } from '@/lib/qa/duck';
import { notifyWecom } from '@/lib/notify';
import { countRetailApi, decodeCompanyId } from '@/lib/collect';
import { countDeliveryApi } from '@/lib/collect-delivery';
import { countWholesaleApi } from '@/lib/collect-wholesale';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';
import type { DetailSource, CheckResult } from '@/lib/qa/types';

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const C0_DAYS = 7;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const checksParam = url.searchParams.get('check');
  const checks = checksParam ? checksParam.split(',') : undefined;
  const trigger = (url.searchParams.get('trigger') || 'manual') as 'cron' | 'collect' | 'deploy' | 'manual';
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: (fn: string, body: Record<string, unknown>) => fetch(`${INSFORGE_API_BASE}/rpc/${fn}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    from: (t: string) => client.database.from(t),
  } as any;
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY, sql);

  const results: CheckResult[] = await runQaChecks({ runId, trigger, db, duck, checks });

  // C0 双向 count（需 token + 源 API，仅 web 上下文可跑）
  for (const src of detailSources as DetailSource[]) {
    if (checks && !checks.includes(`C0:${src.name}`)) continue;
    try {
      const { data: task } = await client.database.from('collect_tasks')
        .select('source_id,params').eq('function_slug', src.function_slug).single();
      const { data: cred } = await client.database.from('auth_credentials')
        .select('credential_data').eq('source_id', task?.source_id).single();
      let token = '';
      try { token = JSON.parse(cred?.credential_data || '{}').token; } catch {}
      const authToken = token.startsWith('Bearer ') ? token : 'Bearer ' + token;

      for (let i = C0_DAYS - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dayIso = d.toISOString().slice(0, 10);
        const dayCompact = dayIso.replace(/-/g, '');
        let apiCount = -1;
        let libCount = 0;
        try {
          const companyId = decodeCompanyId(authToken);
          if (src.name === 'retail') {
            const bn: number[] = task?.params?.branch_nums || [];
            apiCount = await countRetailApi(authToken, bn, bn.join(','), [dayIso, dayIso]);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/retail_detail/${companyId}/${dayIso}/all.parquet')`))[0]?.c as number || 0;
          } else if (src.name === 'delivery') {
            const dbn = Number(task?.params?.distribution_branch_num) || 99;
            apiCount = await countDeliveryApi(authToken, dbn, String(dbn), `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
          } else {
            apiCount = await countWholesaleApi(authToken, '99', `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
          }
        } catch (e) { apiCount = -1; }
        const r = await runC0(src, dayIso, apiCount, libCount);
        results.push({ ...r, run_id: runId, trigger, check_name: src.name });
        await client.database.from('qa_logs').insert([{ ...r, run_id: runId, trigger, check_name: src.name }]).then((x) => x.error && console.error('[qa-run] qa_logs 写入失败', x.error));
      }
    } catch (e) {
      results.push({ run_id: runId, trigger, check_type: 'C0', check_name: src.name, status: 'error', diff: null, detail: [{ error: String(e instanceof Error ? e.message : e) }] });
    }
  }

  const failed = results.filter((r) => r.status !== 'pass');
  if (failed.length) {
    await notifyWecom('⚠️ 数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 15).map((r) => `${r.check_type}:${r.check_name} ${r.status} diff=${r.diff}`).join('\n')}`).catch(() => {});
  } else {
    await notifyWecom('✅ 数据质量巡检通过', `${results.length} 项全部对齐`).catch(() => {});
  }
  return NextResponse.json({ run_id: runId, total: results.length, failed_count: failed.length, results });
}
```

- [ ] **Step 3: 本地验证 route 可访问（需登录态，含 C0 需服务器）**

```bash
cd web && npx tsc --noEmit 2>&1 | tail -5
```
Expected: 无类型错误。完整 C0 运行需部署后在生产以管理员登录态 POST 验证（见 Task 10 部署说明）。

- [ ] **Step 4: 提交**

```bash
git add web/lib/qa/c0.ts web/app/api/admin/qa-run/route.ts
git commit -m "feat(web): C0双向count + /api/admin/qa-run 手动触发+企微告警"
```

---

### Task 9: scheduler 每日定时 + 采集后触发

**Files:**
- Modify: `web/lib/scheduler.ts`

**Interfaces:**
- Consumes: `runQaChecks`（Task 7）、`createClient`（scheduler 已有）
- Produces: 每日 `__qa_full` job（cron `15 9 * * *`，错开现有 09:07 源对账）全量跑；采集成功回调后按受影响源跑 D1。

- [ ] **Step 1: 加 import 与 helper**

在 `web/lib/scheduler.ts` 顶部 import：

```ts
import { runQaChecks } from './qa-runner';
import detailSources from '../../services/semantic-generator/src/detail-sources.json';
import { duckQuery } from './qa/duck';
import type { DetailSource } from './qa/types';
```

在文件内加一个复用 helper（DB + duck 执行器构造，照现有 `__daily_source_reconcile` 模式）：

```ts
async function runDailyQa(trigger: 'cron' | 'collect', checks?: string[], dateFrom?: string, dateTo?: string) {
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: (fn: string, body: Record<string, unknown>) => fetch(`${POSTGREST_URL}/rpc/${fn}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    from: (t: string) => client.database.from(t),
  } as any;
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY!, sql);
  const runId = `${trigger}-${Date.now()}`;
  const results = await runQaChecks({ runId, trigger, db, duck, checks, dateFrom, dateTo });
  const failed = results.filter((r) => r.status !== 'pass');
  if (failed.length) {
    await notifyWecom('⚠️ 每日数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 10).map((r) => `${r.check_type}:${r.check_name} ${r.status}`).join('\n')}`).catch(() => {});
  }
  console.log(`[scheduler] __qa_${trigger}: ${results.length} 检查, 失败 ${failed.length}`);
  return results;
}
```

- [ ] **Step 2: 注册每日 job**

在 `scheduler.ts` 的注册函数区新增（照 `registerDailySourceReconcileJob` 模式）：

```ts
function registerDailyQaJob() {
  const JOB_KEY = "__qa_full";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "15 9 * * *";   // 09:15，错开 09:07 源对账
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try { await runDailyQa('cron'); }
    catch (e: any) { console.error('[scheduler] __qa_full 异常:', e?.message ?? e); }
    finally { runningTasks.delete(JOB_KEY); }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set(JOB_KEY, job);
  console.log('[scheduler] 注册每日数据质量巡检 (15 9 * * *, Asia/Shanghai)');
}
```

- [ ] **Step 3: 注册函数接入调度**

在 `scheduler.ts` 的初始化/注册聚合处（`registerDailySourceReconcileJob()` 被调用的地方）追加：

```ts
registerDailyQaJob();
```

- [ ] **Step 4: 采集后触发 D1**

在 `executeTask` 成功分支（`verified=success/partial` 后、`triggerCompute` 附近）追加对受影响源跑 D1（当日增量后查唯一性）：

```ts
// L4 采集后即时 D1 去重守护（当日明细，轻量）
try {
  const src = (detailSources as DetailSource[]).find((s) => s.function_slug === t.function_slug);
  if (src) {
    const todayCompact = getDateOffsetChina(0).replace(/-/g, '');
    await runDailyQa('collect', [`D1:${src.name}`, `D2:${src.name}`], todayCompact, todayCompact);
  }
} catch (e: any) { console.error('[scheduler] 采集后 QA 失败:', e?.message ?? e); }
```

（`t.function_slug` 为当前执行任务的 function_slug；`getDateOffsetChina` 已存在。）

- [ ] **Step 5: 类型检查**

```bash
cd web && npx tsc --noEmit 2>&1 | tail -5
```
Expected: 无类型错误（若 `AGENT_API_KEY!` 已定义则复用，否则用 `process.env.AGENT_API_KEY!`）。

- [ ] **Step 6: 提交**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(web): scheduler 每日数据质量巡检 job + 采集后 D1 即时守护"
```

---

### Task 10: CLI scripts/qa-run.ts（本地/运维手动跑 D1/D2/C2）

**Files:**
- Create: `scripts/qa-run.ts`

**Interfaces:**
- Consumes: `detail-sources.json`、`qa-checks.json`（tsx import）、pg（`DATABASE_URL`）、duckdb HTTP
- Produces: CLI `npx tsx scripts/qa-run.ts [--check=D1:retail] [--days=N]`，写 qa_logs（pg），exit 0/1。

- [ ] **Step 1: 写 CLI**

创建 `scripts/qa-run.ts`：

```ts
#!/usr/bin/env node
// scripts/qa-run.ts — 本地/运维手动跑 QA（D1/D2/C2），tsx 执行
// 用法：npx tsx scripts/qa-run.ts [--check=D1:retail] [--days=7]
// 环境变量：DATABASE_URL、DUCKDB_URL(默认 http://localhost:9000)、AGENT_API_KEY
// 退出码：0=全部通过  1=有失败
import pg from 'pg';
import { runD1 } from '../web/lib/qa/d1';
import { runD2 } from '../web/lib/qa/d2';
import { runQaChecks } from '../web/lib/qa-runner';
import { duckQuery } from '../web/lib/qa/duck';
import detailSources from '../services/semantic-generator/src/detail-sources.json';
import type { DetailSource } from '../web/lib/qa/types';

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('缺 DATABASE_URL'); process.exit(2); }
  const duckUrl = process.env.DUCKDB_URL || 'http://localhost:9000';
  const apiKey = process.env.AGENT_API_KEY || '';
  const days = parseInt(arg('days') || '7', 10);
  const checks = arg('check');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const db = {
    // qa_d2_dup_rows(TEXT, TEXT[])：p_table 单引号内必须转义；p_keys 拼 ARRAY 字面量
    rpc: async (fn: string, body: Record<string, unknown>) => {
      const tbl = String(body.p_table).replace(/'/g, "''");
      const keys = (body.p_keys as string[]).map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
      const r = await client.query(`SELECT * FROM ${fn}('${tbl}', ARRAY[${keys}]::text[])`);
      return { data: r.rows };
    },
    from: (t: string) => ({
      select: async (cols: string) => {
        const r = await client.query(`SELECT ${cols} FROM ${t}`);
        return { data: r.rows };
      },
      insert: async (rows: unknown[]) => {
        for (const row of rows as Record<string, unknown>[]) {
          await client.query(
            `INSERT INTO ${t} (run_id, trigger, check_type, check_name, status, diff, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [row.run_id, row.trigger, row.check_type, row.check_name, row.status, row.diff ?? null, row.detail ? JSON.stringify(row.detail) : null],
          );
        }
        return { data: rows };
      },
    }),
  } as any;

  const duck = (sql: string) => duckQuery(duckUrl, apiKey, sql);
  const runId = `cli-${Date.now()}`;
  const results = await runQaChecks({ runId, trigger: 'manual', db, duck, checks: checks?.split(',') });

  await client.end();
  const failed = results.filter((r) => r.status !== 'pass');
  results.forEach((r) => console.log(`[${r.check_type}:${r.check_name}] ${r.status}${r.diff != null ? ` diff=${r.diff}` : ''}`));
  console.log(failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
```

（CLI 的 `db.rpc` 已按 `qa_d2_dup_rows(TEXT, TEXT[])` 签名构造 ARRAY 字面量，无需占位。）

- [ ] **Step 2: 类型检查**

```bash
cd services/semantic-generator && npx tsc --noEmit 2>&1 | tail -5
```
Expected: 无类型错误（scripts/qa-run.ts 属仓库根，可用 semantic-generator 的 tsc 校验，必要时在 web/tsconfig include 加 scripts）。

- [ ] **Step 3: 本地跑一次（对 dev DB / 隧道 prod DB）**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis
DATABASE_URL=<dev或prod隧道URL> DUCKDB_URL=http://localhost:9000 AGENT_API_KEY=<key> \
  services/semantic-generator/node_modules/.bin/tsx scripts/qa-run.ts --check=D1:retail --days=3
```
Expected: 输出 `[D1:retail] pass` 或列重复行；exit 0/1 符合。

- [ ] **Step 4: 提交**

```bash
git add scripts/qa-run.ts
git commit -m "feat(scripts): qa-run CLI（本地/运维手动跑 D1/D2/C2，tsx）"
```

---

### Task 11: 部署 + 生产验证

**Files:**
- 无新增（部署流程文件只读）

**Interfaces:**
- 验证 P0 全链路：迁移→生成器→web route→scheduler。

- [ ] **Step 1: 推送触发 GHA**

```bash
git add -A && git commit -m "feat(qa): 语义层数据准确性守护 P0（qa_logs+配置+D1/D2+C2+运行器+四类触发）" || true
git push origin main
gh run list --limit 3
```

- [ ] **Step 2: 验证迁移与生成器产物已应用**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '\d qa_logs'"
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT viewname FROM pg_views WHERE viewname LIKE ''%_qa'';'"
```
Expected: `qa_logs` 存在；`report_brand_metric_gen_qa` 视图存在。

- [ ] **Step 3: 手动触发一次全量巡检**

浏览器（管理员登录态）POST：
```
https://data.shanhaiyiguo.com/api/admin/qa-run
```
Expected: 返回 JSON（run_id + 各项结果），qa_logs 有记录，企微收到巡检结果。

- [ ] **Step 4: 校准 D1 自然键（关键）**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-duckdb-1 node /app/scripts/qa-run.ts" 2>/dev/null || true
# 或从 /api/admin/qa-run 结果里看 D1:delivery / D1:wholesale 是否有 fail
```
- 若 D1 报 fail 且 diff 小（几行）→ 采样 detail 确认是**真重复**还是 **key 过窄的合法行**（如同一订单同商品两行明细）。
- 真重复 → 保留告警，修复 transform/merge 去重（`dedupe_key` 改用业务键）。
- key 过窄 → 更新 `detail-sources.json` natural_key（如 delivery 加 `lot_number`）→ 重跑 gen-views（Task 4/5 流程）→ 重新提交 `database/generated` → 推送。
- 校准结果同步更新 qa-config.test.ts 的断言与 spec 文档。

- [ ] **Step 5: 确认每日 job 已注册**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-web-1 --tail 200 2>&1 | grep __qa_full | head"
```
Expected: `注册每日数据质量巡检 (15 9 * * *, Asia/Shanghai)`。

---

## 收尾（P1/P2 后续，不在本计划内）

- **P1 收口**：删除 `scripts/reconcile-check.js` 硬编码查询（三表查询迁 detail-sources）；C1 精确对齐（wholesale 64188 客户拆分品牌映射经 dim_branch）；周对账 route 并入 C0；cron-reconcile.sh 退役；**自动修复分级**（C0 缺漏自动调 `/collect-backfill` 补采 ≤3 次/轮、C1 差异自动调 `/compute` 重算 ≤3 次/轮；D1/D2 重复只告警不自动删）。
- **P2 加固**：全视图 viewAssertions 补齐（类别/门店下钻/商品/批发客户/日报）；C4 契约测试扩展 + `_qa` SQL 快照；管理端结果列表页。
