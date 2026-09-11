# 补货(要货单)明细接入问数 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenClaw 能准确查询 OSS 上的补货（要货单）明细——把「注册表通用事实视图」能力从维表推广到事实表，并把补货数据集接进去，附带到达/完整性守护。

**Architecture:** 在 `datasets` 表加一列 `scope_key_expr`（门店复合键 SQL 表达式）作为通用事实数据集的声明式契约；网关把该能力抽到共享纯函数 `functions/_shared/fact-view.ts`（可单测），对注册表声明的 fact 数据集统一构建「按注册列投影 + 行级权限裁剪」的 DuckDB 临时视图；存量两个硬编码视图 `retail_detail`/`outbound_detail` 完全不动。守护**复用**已接线但未实现的 `data_freshness`，并**新增** `data_volume`（不使用 `data_integrity`——其原义已被 QA 体系承担）。

**Tech Stack:** Deno edge function（CommonJS，esbuild 打包）/ DuckDB（S3 直读 parquet）/ PostgREST / PostgreSQL 幂等迁移 / Next.js + vitest（web 侧）/ OpenClaw native plugin + SKILL.md

**Spec:** `docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md`

## Global Constraints

- **部署次序是硬约束**（违反会打挂现有报表问答）：
  `① architecture.md → ② agent-query function → ③ 迁移 212 → ④ restart postgrest → ⑤ 迁移 213 → ⑥ monitor evaluator（可在 213 前后）`
- **`scope_key_expr` 与逐数据集列必须走独立请求 + 独立 try/catch**，**绝不可并入 `loadRegistry` 现有的 `datasets?select=...` 主查询**。PostgREST 对未知列返 400，主查询一挂整个 `loadRegistry` 走 fallback → `pgTables` 退回只剩 3 张报表表 → 现有 `report_*_gen` 查询误路由到 DuckDB 而失败。
- **视图里的账套列名必须是 `system_book_code`**（`assertBranchJoin` 是字面量匹配，不认 `sbc`/`company_id`）。
  但**源 parquet 的列名不必叫这个**——用 `dataset_columns.source_name` 声明「源列名 → 视图列名」映射，
  投影写 `"<source_name>" AS "<name>"`（`source_name` 为空则退回 `name`，即同名前缀）。
  ⚠️ `scope_key_expr` 在**投影后的视图列**上求值，所以它一律用**视图列名**（`system_book_code`），绝不用源列名。
- **实测列名/类型真值（2026-09-11 用服务器 DuckDB 对真实 parquet 验证，不要凭 spec 的字段调研表猜）**：
  账套列 `company_id` (VARCHAR，**parquet 里没有 `system_book_code`**)；`branch_num` / `out_branch_num` / `item_num` (BIGINT)；
  `quantity` / `use_quantity` / `subtotal` (DOUBLE)；其余注册列 VARCHAR。
  `company_id || '-' || branch_num` **可直接拼接**（DuckDB 隐式转字符串），无需 CAST；实测该分区产出 86 个不同复合键。
- **⚠️ 部署前必须做一次「真实 parquet 干跑」**：把注册的投影 + `scope_key_expr` 对着**真实 OSS 分区**跑一遍
  （在服务器上用 DuckDB 直接跑即可，**不必部署**）。本机 DuckDB 连不上内网 S3，**本机测不出这类错误**——
  第一版注册值就是带着 `Binder Error: Referenced column "system_book_code" not found` 一路通过评审的，
  若走到生产冒烟才发现，整个功能零可用。
- **`total_money` 不注册**（单头金额逐行重复，行级 SUM 整单翻倍）。靠「按注册列投影」自动从视图消失。
- **视图列 = `dataset_columns` 注册列**（显式投影，非 `SELECT *`）。注册列为空 → 不构建视图（fail-close）。
- **fail-close**：`scope_key_expr` 为空/非法 → 不建视图、不进白名单。授权空集 → `WHERE 1=0`（不是「不过滤」）。
- **不做存量重构**：`retail_detail` / `outbound_detail` 仍走原硬编码分支，通用路径显式跳过这两个名字。
- **沿用「全量构建」模式**：每查询无条件构建全部权限视图（保持现状，不引入懒构建）。
- **迁移必须幂等**：`ADD COLUMN IF NOT EXISTS` / `ON CONFLICT` / `WHERE NOT EXISTS`；迁移头注释须写 `-- spec: docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md`（pre-commit 迁移↔spec 关联守卫）。
- **测试命令**：`cd web && npm test`（vitest，**不做类型检查**）；类型检查必须跑 `cd web && npm run build`。
- **⚠️ `index.bundle.js` 是入仓产物，必须随源码同步重生成并提交**（`scripts/check-functions.sh` 有漂移门禁：
  现场 esbuild 产物 ≠ 已提交产物 → pre-commit 直接失败）。生产服务器**无 node/npx**，部署的就是这个提交的 bundle，
  漏提交 = 生产静默跑旧代码。凡动 `functions/agent-query/index.js` 或 `functions/_shared/*`，都要跑：
  `npx --yes esbuild functions/agent-query/index.js --bundle --format=cjs --outfile=functions/agent-query/index.bundle.js`
- 回滚：字典 `DELETE FROM datasets WHERE name='replenishment_detail'`；守护 `UPDATE monitor_rules SET enabled=false WHERE check_type IN ('data_freshness','data_volume')`。
- **check_type 语义裁定（2026-09-11，人决策）**：`data_freshness` **复用**（它本就意为「数据够不够新」，我们的分区到达检查是它的一个具体实例），
  但须把 §8.1 表格该行的「数据源/触发」**拓宽**以覆盖两种含义；行数异常**新增类型 `data_volume`**（不走 `data_integrity`）——
  `data_integrity` 文档原义是「DuckDB 明细 count vs PG 汇总 差异率」且已注明「部分职能由 QA 体系承担」（`web/lib/qa/config/detail-sources.json` + C1 链在真实承担），
  用该名字装行数异常会覆盖一个已有归属的架构槽位。**`data_integrity` 保持 ⏳ 未实现不动**。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `docs/architecture.md` | §4.3 注册表能力、§8.1 守护类型 | Modify（架构先行） |
| `functions/_shared/fact-view.ts` | 通用事实视图的两件纯逻辑：表达式校验 + 视图 SQL 生成 | Create |
| `web/lib/agent-query/__tests__/fact-view.test.ts` | 上述纯函数的契约单测（跨包镜像，同 `sql-guards.test.ts` 惯例） | Create |
| `functions/agent-query/index.js` | 注册表读取（隔离）、视图构建接线、白名单派生 | Modify |
| `database/migrations/212_registry_fact_scope.sql` | `datasets.scope_key_expr` 列 | Create |
| `database/migrations/213_replenishment_detail_registry.sql` | 补货数据集注册 + 4 条守护规则 | Create |
| `web/lib/monitor/types.ts` | `EvalDeps` 加 `duckdbQuery` | Modify |
| `web/lib/monitor/runtime.ts` | `buildDeps` 注入 `duckdbQuery` | Modify |
| `web/lib/monitor/evaluators/data-freshness.ts` | 分区到达守护 | Create |
| `web/lib/monitor/evaluators/data-integrity.ts` | 行数异常守护 | Create |
| `web/lib/monitor/evaluators/index.ts` | `EVALUATORS` 注册两个新 evaluator | Modify |
| `web/lib/monitor/evaluators/__tests__/data-freshness.test.ts` | 到达守护单测 | Create |
| `web/lib/monitor/evaluators/__tests__/data-integrity.test.ts` | 行数守护单测 | Create |
| `web/lib/monitor/**/__tests__/*.test.ts`（5 个存量） | 补 `duckdbQuery` 到 deps fake | Modify |
| `openclaw/data-query-plugin/skills/retail-query/SKILL.md` | ⑫补货模板 | Modify |

---

### Task 1: 架构文档先行更新

**Files:**
- Modify: `docs/architecture.md`（§4.3 数据注册中心、§8.1 监控）

**Interfaces:**
- Consumes: 无
- Produces: 无（文档）；但按仓库 CLAUDE.md「架构先行」，本任务必须先于一切代码改动合并。

- [ ] **Step 1: 更新 §4.3 数据注册中心段**

在 `docs/architecture.md` 的 §4.3「🆕 数据注册中心 = 取数知识单一事实源（迁移 031）」段落中，把「自动感知」那句的适用范围讲准。定位现有这一行：

```
- **自动感知**：新增维表/报表 = `datasets` 插一行 → 两侧下一轮即见，**不改 markdown、内容变更不重部署**（插件/function 各只一次性改动）。
```

替换为：

```
- **自动感知**：新增维表/报表 = `datasets` 插一行 → 两侧下一轮即见，**不改 markdown、内容变更不重部署**（插件/function 各只一次性改动）。
- **🆕 通用事实视图（迁移 212，2026-09-11）**：上述「插一行即见」原先只对维表（`kind=dim AND carry_enabled`）与 `pg_table` 成立；
  **事实表（`kind=fact`）此前无通用路径**——`retail_detail` / `outbound_detail` 的视图是硬编码在 `functions/agent-query/index.js` 的。
  现新增声明式契约：`datasets.scope_key_expr`（事实数据集的**门店复合键 SQL 表达式**，对注册列求值，产出归一形态 `sbc-branch_num`）。
  网关对 `engine='duckdb_view' AND kind='fact' AND scope_key_expr IS NOT NULL AND exposed` 的数据集统一构建：
  ① 列投影 = `dataset_columns` 注册列（**显式投影，非 `SELECT *`**；敏感列套 `CASE WHEN can_see_cost THEN col ELSE NULL END`）→
  未注册的列（如逐行重复的单头金额）天然不出现；② 行级权限 = `WHERE <scope_key_expr> IN (<授权复合键>)`，授权空集 → `WHERE 1=0`。
  `scope_key_expr` 空/非法 / 注册列为空 → **不构建视图且不进 SQL 白名单（fail-close）**。
  两个存量硬编码视图**不重构**（它们有 union / 内联 dim join 的定制逻辑），通用路径显式跳过其名字。
  **注册表的通用事实扩展必须独立请求读取**（不得并入主 `datasets?select=`）——PostgREST 对未知列返 400，
  主查询失败会使 `pgTables` 回退到硬编码兜底值，导致 `report_*_gen` 查询误路由到 DuckDB。
```

- [ ] **Step 2: 更新 §8.1 监控段，登记两个守护类型**

找到 §8.1 中讲 `monitor_rules` 的段落，在其后追加一段：

```
**数据到达/完整性守护（2026-09-11 落地）**：`CheckType` 早已声明 `data_freshness` / `data_integrity` 两个类型但一直无 evaluator（空跑）。
现用于守护**外部管线**写入 OSS 的数据集（如 `replenishment_detail`）：`data_freshness` 走 `runHourlyBucket`（每小时）检查昨日分区是否到达；
**新类型 `data_volume`** 走 `runDailyBucket`（每日 03:00）检查昨日行数 vs 近 7 日中位数偏离。**按账套各配一行规则**（禁止看合计，会被另一账套掩盖）。
探测走 DuckDB 服务（web 容器无 boto3）；探测异常**不报警**（duckdb 本体故障由 `service_down` 桶负责，避免双报）。
`runScan` 的双层隔离（无 evaluator 规则 `warn + continue`、每规则独立 `try/catch`）保证**规则可先于 evaluator 落库**。
```

- [ ] **Step 3: 提交**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): 注册表通用事实视图（scope_key_expr）+ 数据到达守护

- §4.3 登记「新增数据集=插一行」原先只覆盖维表/pg_table，事实表是硬编码
- §8.1 登记 data_freshness（复用）与新增 data_volume 两个 CheckType 的落地"
```

---

### Task 2: 通用事实视图纯函数（TDD）

**Files:**
- Create: `functions/_shared/fact-view.ts`
- Test: `web/lib/agent-query/__tests__/fact-view.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）
- Produces:
  - `export interface FactColumn { name: string; sensitive: boolean }`
  - `export interface FactViewSpec { name: string; glob: string; scopeKeyExpr: string; columns: FactColumn[]; authKeys: string[]; allBranches: boolean; canSeeCost: boolean }`
  - `export function validateScopeKeyExpr(expr: string, columnNames: string[]): void`（非法时 throw，`e.message` 为错误码）
  - `export function buildFactViewSql(spec: FactViewSpec): string`

- [ ] **Step 1: Write the failing test**

创建 `web/lib/agent-query/__tests__/fact-view.test.ts`：

```ts
// 通用事实视图纯函数单测（functions/_shared/fact-view.ts 的镜像契约）
// 背景：spec 2026-09-11-replenishment-detail-query-onboarding-design
// 关键不变量：① 列投影只含注册列（未注册列如单头金额天然消失）
//            ② 行过滤 fail-close（授权空集 → WHERE 1=0，非「不过滤」）
//            ③ 表达式校验挡住常量/多语句（防行过滤失效 → 越权）
import { describe, it, expect } from "vitest";
import {
  validateScopeKeyExpr,
  buildFactViewSql,
  sqlLit,
} from "../../../../functions/_shared/fact-view";

const COLS = ["system_book_code", "branch_num", "branch_name", "subtotal", "total_money"];

describe("sqlLit（共享转义，agent-query 亦复用）", () => {
  it("普通串加引号", () => {
    expect(sqlLit("3120-7")).toBe("'3120-7'");
  });

  it("单引号翻倍（防注入）", () => {
    expect(sqlLit("a'b")).toBe("'a''b'");
  });
});

describe("validateScopeKeyExpr", () => {
  it("合法表达式通过", () => {
    expect(() =>
      validateScopeKeyExpr(
        "regexp_replace(system_book_code || '-' || branch_num, '^([0-9]+)-0+([0-9]+)$', '\\1-\\2')",
        COLS
      )
    ).not.toThrow();
  });

  it("空表达式拒绝 empty_scope_expr", () => {
    expect(() => validateScopeKeyExpr("   ", COLS)).toThrowError(/empty_scope_expr/);
  });

  it("多语句拒绝 scope_expr_semicolon", () => {
    expect(() => validateScopeKeyExpr("system_book_code; DROP TABLE x", COLS)).toThrowError(
      /scope_expr_semicolon/
    );
  });

  it("子查询拒绝 scope_expr_forbidden_keyword", () => {
    expect(() =>
      validateScopeKeyExpr("(SELECT 'x' FROM t) || branch_num", COLS)
    ).toThrowError(/scope_expr_forbidden_keyword/);
  });

  it("不引用本数据集任何列 → scope_expr_no_column（挡纯常量）", () => {
    expect(() => validateScopeKeyExpr("'3120-7'", COLS)).toThrowError(/scope_expr_no_column/);
  });

  // ★ 常量折叠绕过（2026-09-11 评审实证）：列名只出现在字符串字面量里 → 必须同样拒绝，
  //   否则 WHERE <常量> IN ('3120-7') 恒真 = 行过滤失效 = 越权。
  it("列名只在字面量里 → 仍拒绝（防常量折叠越权）", () => {
    expect(() => validateScopeKeyExpr("'branch_num' || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    expect(() => validateScopeKeyExpr("left('branch_num', 0) || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    expect(() =>
      validateScopeKeyExpr("regexp_replace('branch_num', '.*', '3120-7')", COLS)
    ).toThrowError(/scope_expr_no_column/);
  });

  it("注释 / 方言字面量里的列名 → 仍拒绝（同一绕过类的其余形态）", () => {
    // 块注释（复审运行时实证）
    expect(() => validateScopeKeyExpr("/* branch_num */ '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    // DuckDB dollar-quoted（$$…$$ 与 $tag$…$tag$）
    expect(() => validateScopeKeyExpr("$$branch_num$$ || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    expect(() => validateScopeKeyExpr("$t$branch_num$t$ || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    // E'…' 反斜杠转义字符串
    expect(() => validateScopeKeyExpr("E'\\'branch_num' || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
  });

  it("字面量里含禁词不误拒（关键字扫描同样先剥字面量）", () => {
    expect(() =>
      validateScopeKeyExpr("regexp_replace(branch_name, 'delete', '')", COLS)
    ).not.toThrow();
  });

  it("引用列名但大小写不同视为合法（SQL 标识符不区分大小写）", () => {
    expect(() => validateScopeKeyExpr("SYSTEM_BOOK_CODE || '-' || branch_num", COLS)).not.toThrow();
  });
});

describe("buildFactViewSql：列投影 = 注册列", () => {
  const base = {
    name: "replenishment_detail",
    glob: "s3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet",
    scopeKeyExpr: "system_book_code || '-' || branch_num",
    canSeeCost: false,
  };

  it("未注册的列不出现在视图里（total_money 消失）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [
        { name: "system_book_code", sensitive: false },
        { name: "branch_num", sensitive: false },
        { name: "subtotal", sensitive: false },
      ],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('"subtotal"');
    expect(sql).not.toContain("total_money");
  });

  it("敏感列套 CASE WHEN 脱敏", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "profit", sensitive: true }],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('CASE WHEN FALSE THEN "profit" ELSE NULL END AS "profit"');
  });

  it("canSeeCost=true 时脱敏开关放开", () => {
    const sql = buildFactViewSql({
      ...base,
      canSeeCost: true,
      columns: [{ name: "profit", sensitive: true }],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('CASE WHEN TRUE THEN "profit" ELSE NULL END AS "profit"');
  });

  it("授权空集 → WHERE 1=0（fail-close，不是不过滤）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: false,
    });
    expect(sql).toContain("WHERE 1=0");
    expect(sql).not.toContain("IN (");
  });

  it("全量授权 → 不加行过滤", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: true,
    });
    expect(sql).not.toContain("WHERE");
  });

  it("窄授权 → IN 列表 + 单引号转义 + WHERE 用 scopeKeyExpr 本尊", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: ["3120-7", "3120-8"],
      allBranches: false,
    });
    expect(sql).toContain(`IN ('3120-7', '3120-8')`);
    // ★ 钉住核心契约：WHERE 左值必须是传入的 scopeKeyExpr 本尊——
    //   否则「丢掉表达式、只留 IN 列表」的实现能通过其余全部用例（行过滤实质失效）。
    expect(sql).toContain(`WHERE ${base.scopeKeyExpr} IN ('3120-7', '3120-8')`);
  });

  it("始终读 parquet 全列（union_by_name）并按名字取注册列", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: true,
    });
    expect(sql).toContain(`read_parquet('${base.glob}', union_by_name=true)`);
    expect(sql).toMatch(/CREATE OR REPLACE TEMP VIEW replenishment_detail AS/);
  });

  it("注册列名为空 → 拒绝 empty_columns", () => {
    expect(() =>
      buildFactViewSql({ ...base, columns: [], authKeys: ["3120-7"], allBranches: false })
    ).toThrowError(/empty_columns/);
  });

  // ★ source_name 映射（2026-09-11 加）：平台口径名 ≠ 外部管线列名时的正解，避免要求对方改名
  it("sourceName 非空 → 投影为 \"源列名\" AS \"视图列名\"", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [
        { name: "system_book_code", sensitive: false, sourceName: "company_id" },
        { name: "branch_num", sensitive: false },
      ],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('"company_id" AS "system_book_code"');
    expect(sql).toContain('"branch_num" AS "branch_num"');
  });

  it("sourceName 为空 → 退回同名（行为与加映射前一致）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: true,
    });
    expect(sql).toContain('"branch_num" AS "branch_num"');
    expect(sql).not.toContain("company_id");
  });

  it("敏感列 + sourceName → 脱敏作用在源列上、别名仍为视图列名", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "profit", sensitive: true, sourceName: "profit_money" }],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain(
      'CASE WHEN FALSE THEN "profit_money" ELSE NULL END AS "profit"'
    );
  });

  it("scope_key_expr 用视图列名求值（不是源列名）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [
        { name: "system_book_code", sensitive: false, sourceName: "company_id" },
        { name: "branch_num", sensitive: false },
      ],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    // WHERE 里出现的必须是视图列名 system_book_code，源列名 company_id 只应出现在投影层
    expect(sql).toContain('WHERE system_book_code');
    expect(sql).not.toContain('WHERE company_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/agent-query/__tests__/fact-view.test.ts`
Expected: FAIL —— `Failed to resolve import "../../../../functions/_shared/fact-view"`

- [ ] **Step 3: Write minimal implementation**

创建 `functions/_shared/fact-view.ts`：

```ts
// functions/_shared/fact-view.ts
// 通用事实视图的纯逻辑（spec 2026-09-11-replenishment-detail-query-onboarding-design §方案1）
// 零依赖，供 functions/agent-query/index.js require，并在 web/lib/agent-query/__tests__/fact-view.test.ts 锁定契约。
//
// 职责边界：只做「表达式合法性」与「视图 SQL 拼接」两件事，不碰网络/权限数据获取。
// 三条不变量（改动前先读单测）：
//   ① 列投影 = dataset_columns 注册列（显式投影，不用 SELECT *）→ 未注册列天然不可见
//   ② 行过滤 fail-close：授权空集 → WHERE 1=0
//   ③ 表达式必须引用本数据集至少一列 → 挡住纯常量（行过滤失效即越权）

export interface FactColumn {
  name: string; // 视图里的列名（平台口径名）
  sensitive: boolean;
  sourceName?: string; // parquet 里的源列名；为空表示与 name 同名。例：name='system_book_code', sourceName='company_id'
}

export interface FactViewSpec {
  name: string;
  glob: string;
  scopeKeyExpr: string;
  columns: FactColumn[];
  authKeys: string[];
  allBranches: boolean;
  canSeeCost: boolean;
}

// SQL 字符串字面量转义（单引号翻倍）。导出供 agent-query/index.js 复用，避免两份实现漂移。
export function sqlLit(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function sqlIdent(s: string): string {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

// 表达式里出现即视为危险的关键字（子查询/写操作）；只做词边界匹配，不解析 SQL
const EXPR_FORBIDDEN_KEYWORDS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
  "ATTACH", "DETACH", "COPY", "PRAGMA", "GRANT", "REVOKE", "TRUNCATE", "CALL",
];

// 剥掉 SQL 字符串字面量（单引号，'' 为转义）与行注释，再做关键字/列名扫描。
// ★ 必须先去字面量，否则：
//   ① 列名检查可被常量折叠绕过——`'branch_num' || '3120-7'` 文本里含列名却折叠成常量，
//      `WHERE <常量> IN ('3120-7')` 恒真 → 行过滤失效 → 被授权单店者看见整账套（2026-09-11 评审实证）；
//   ② 关键字检查会误拒 `regexp_replace(branch_name, 'delete', '')` 这类含禁词字面量的合法表达式。
//   fail-close 方向：剥完若不再含任何列名 → scope_expr_no_column 拒绝。
function stripSqlLiterals(expr: string): string {
  return String(expr)
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 块注释（2026-09-11 复审实证：/* branch_num */ '3120-7' 曾绕过）
    .replace(/--[^\n]*/g, " ") // 行注释
    // DuckDB 方言字面量：dollar-quoted（$$…$$ / $tag$…$tag$）；组 1 未参与匹配时 \1 匹配空串，故 $$…$$ 亦覆盖
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/E'(?:[^'\\]|\\.|'')*'/gi, "''") // E'…' 反斜杠转义字符串
    .replace(/'(?:[^']|'')*'/g, "''"); // 普通字符串字面量
}

// 门店复合键表达式校验。非法抛错（message = 错误码），调用方据此 fail-close（不建视图 + 不进白名单）。
export function validateScopeKeyExpr(expr: string, columnNames: string[]): void {
  const t = String(expr ?? "").trim();
  if (!t) throw new Error("empty_scope_expr");
  if (t.includes(";")) throw new Error("scope_expr_semicolon"); // 分号在字面量里也无害，但拒绝更安全
  const bare = stripSqlLiterals(t); // ← 关键字/列名扫描一律在剥离字面量后的文本上做
  const u = bare.toUpperCase();
  for (const kw of EXPR_FORBIDDEN_KEYWORDS) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("scope_expr_forbidden_keyword");
  }
  // 必须引用本数据集至少一列（**字面量里的列名不算**，挡常量折叠）
  const hit = columnNames.some((c) =>
    new RegExp("\\b" + String(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(bare)
  );
  if (!hit) throw new Error("scope_expr_no_column");
}

// 生成权限视图 SQL。caller 负责先跑 validateScopeKeyExpr 与「注册列非空」校验。
export function buildFactViewSql(spec: FactViewSpec): string {
  const cols = spec.columns || [];
  if (cols.length === 0) throw new Error("empty_columns");
  const canSee = spec.canSeeCost ? "TRUE" : "FALSE";
  // ① 列投影：敏感列整组按 can_see_cost 脱敏；源列名可与视图列名不同（source_name 映射）
  // 例：name='system_book_code' + sourceName='company_id' → "company_id" AS "system_book_code"
  const srcIdent = (c: FactColumn) => sqlIdent(c.sourceName ?? c.name);
  const projection = cols
    .map((c) =>
      c.sensitive
        ? `CASE WHEN ${canSee} THEN ${srcIdent(c)} ELSE NULL END AS ${sqlIdent(c.name)}`
        : `${srcIdent(c)} AS ${sqlIdent(c.name)}`
    )
    .join(", ");
  // ② 行过滤：全量授权不加过滤；否则 IN 授权复合键；空集 → 1=0（fail-close）
  const where = spec.allBranches
    ? ""
    : spec.authKeys.length === 0
      ? " WHERE 1=0"
      : " WHERE " + spec.scopeKeyExpr + " IN (" + spec.authKeys.map(sqlLit).join(", ") + ")";
  return (
    "\nCREATE OR REPLACE TEMP VIEW " + spec.name + " AS SELECT * FROM (" +
    "SELECT " + projection + " FROM read_parquet(" + sqlLit(spec.glob) + ", union_by_name=true)" +
    ") t" + where + ";"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run lib/agent-query/__tests__/fact-view.test.ts`
Expected: PASS（23 个用例全绿：2 sqlLit + 9 validateScopeKeyExpr + 12 buildFactViewSql）

- [ ] **Step 5: 确认没有破坏既有守卫单测**

Run: `cd web && npx vitest run lib/agent-query`
Expected: PASS（新增 `fact-view.test.ts` + 既有 `sql-guards.test.ts` 全绿）

- [ ] **Step 6: Commit**

```bash
git add functions/_shared/fact-view.ts web/lib/agent-query/__tests__/fact-view.test.ts
git commit -m "feat(agent-query): 通用事实视图纯函数——表达式校验 + 列投影 + fail-close 行过滤"
```

---

### Task 3: 网关接线（注册表隔离读取 + 通用视图 + 白名单派生）

**Files:**
- Modify: `functions/agent-query/index.js`（`loadRegistry`、`runDuckdb`、入口的 `allowedTables` 组装）

**Interfaces:**
- Consumes: Task 2 的 `validateScopeKeyExpr` / `buildFactViewSql` / `FactColumn`
- Produces: `REG_CACHE` 新增 `factViews: Array<{ name: string; glob: string; scopeKeyExpr: string; columns: FactColumn[] }>`

> **为什么本任务没有单测**：改动全是 I/O 编排（PostgREST 取数、拼视图串、路由）。可测的纯逻辑已全部落在 Task 2。
> 本任务的验证是「语法 + 全量既有单测不回归 + Task 11 的生产冒烟」。不要为了凑测试把 I/O 拆出来。
>
> spec 权限表里那条「注册表主查询故障（模拟 400）→ 走 fallback 且 `pgTables` 仍为报表表全集」，
> 在本设计下是**结构性保证而非可运行时注入的场景**：`loadFactScopes` 是独立请求，它无论怎么失败都改不到
> `pgTables` 的赋值路径。**审查方式是读代码确认这一点**；运行时侧由 Task 11 Step 3 断言 `engine === 'pg'` 兜底。

- [ ] **Step 1: 在 import 区加纯函数引用**

`functions/agent-query/index.js` 顶部现有三行 `require`：

```js
const { signJwt } = require("../_shared/jwt");
const { json: sharedJson } = require("../_shared/cors");
const { assertCompositeKeyJoins } = require("../_shared/sql-guards");
```

在其后追加一行：

```js
const { validateScopeKeyExpr, buildFactViewSql, sqlLit } = require("../_shared/fact-view");
```

- [ ] **Step 1b: 删掉本文件里的 `sqlLit` 本地定义（改用共享版）**

`functions/agent-query/index.js` 的工具区现有：

```js
function sqlLit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"; // branch_num 等数值字符串
}
```

**删除这三行**——改为由 Step 1 引入的 `../_shared/fact-view` 导出提供（语义逐字相同）。删完确认文件里不再有 `function sqlLit` 定义：

```bash
grep -n "function sqlLit" functions/agent-query/index.js
```

Expected: 无输出

- [ ] **Step 2: 新增「硬编码视图名」常量**

在 `const MAX_ROWS = 1000;` 上方（配置区）加：

```js
// 通用事实视图必须跳过的名字：这两个视图有 union / 内联 dim join 的定制逻辑，
// 由 runDuckdb 硬编码构建，注册表不得介入（spec 全局约束「不做存量重构」）。
const HARDCODED_VIEW_NAMES = new Set(["retail_detail", "outbound_detail"]);
```

- [ ] **Step 3: 新增 `loadFactScopes()`（独立请求，绝不并入主查询）**

在 `loadRegistry` 函数定义之前插入：

```js
// 通用事实视图数据集读取（spec §方案1）。
// ★ 必须独立请求 + 独立 try/catch：PostgREST 对 select= 里的未知列返 400，
//   若并入 loadRegistry 的主 datasets 查询，一次 400 会让整个注册表走 fallback
//   → pgTables 退回硬编码 3 张报表表 → 现有 report_*_gen 查询误路由到 DuckDB 而失败。
//   独立后：列缺失/请求失败只让「新数据集不可用」（fail-close），不碰存量。
async function loadFactScopes() {
  const out = [];
  let rows = [];
  try {
    const headers = { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" };
    const r = await fetch(
      POSTGREST_URL +
        "/datasets?select=name,source,scope_key_expr&engine=eq.duckdb_view&kind=eq.fact&exposed=is.true&scope_key_expr=not.is.null",
      { headers },
    );
    if (!r.ok) {
      console.error("[agent-query] loadFactScopes datasets http " + r.status);
      return out;
    }
    rows = await r.json();
  } catch (e) {
    console.error("[agent-query] loadFactScopes datasets failed:", String(e));
    return out;
  }
  const headers = { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" };
  for (const d of rows || []) {
    if (!d.name || !d.source || HARDCODED_VIEW_NAMES.has(d.name)) continue;
    // 列清单（含敏感标记）逐数据集读；读失败 → 该数据集 fail-close（不构建）
    let columns = [];
    try {
      const cr = await fetch(
        POSTGREST_URL + "/dataset_columns?select=name,is_sensitive,source_name&dataset_name=eq." +
          encodeURIComponent(d.name) + "&order=ordinal.asc",
        { headers },
      );
      if (cr.ok) {
        // source_name：源列名 → 视图列名映射（为空表示同名）。例：system_book_code ← company_id
        // ★ 这里必须用**真值判断**（不是 `??` / `!== null`）：注册列被写成 `''` 是很现实的情形
        //   （迁移作者习惯空串而非 NULL），而 `''` 传下去会让 buildFactViewSql 生成
        //   `"" AS "x"` —— 零长度定界标识符 → DuckDB 建视图报错 → 该数据集整体不可用。
        //   空串在这里被归一为「不传 sourceName」= 退回同名，正是我们要的语义。**勿"简化"成 ??。**
        columns = (await cr.json()).map((c) => ({
          name: c.name,
          sensitive: !!c.is_sensitive,
          ...(c.source_name ? { sourceName: c.source_name } : {}),
        }));
      }
    } catch (e) {
      console.error("[agent-query] loadFactScopes columns failed " + d.name + ":", String(e));
    }
    if (columns.length === 0) {
      console.error("[agent-query] fact dataset " + d.name + " 无注册列，跳过（fail-close）");
      continue;
    }
    try {
      validateScopeKeyExpr(d.scope_key_expr, columns.map((c) => c.name));
    } catch (e) {
      console.error("[agent-query] fact dataset " + d.name + " scope_key_expr 非法（" + e.message + "），跳过");
      continue;
    }
    out.push({ name: d.name, glob: d.source, scopeKeyExpr: d.scope_key_expr, columns });
  }
  return out;
}
```

- [ ] **Step 4: 把 `factViews` 挂进 `loadRegistry`**

在 `loadRegistry` 中，`let dimCarry = [];` 下面加一行：

```js
  let dimCarry = [];
  let factViews = [];
```

在函数体末尾（`REG_CACHE = { retailGlob, costColumns, pgTables, dimCarry };` 处）改为：

```js
  // 通用事实视图：独立 try/catch，失败只影响新数据集（见 loadFactScopes 注释）
  try {
    factViews = await loadFactScopes();
  } catch (e) {
    console.error("[agent-query] loadFactScopes 未捕获异常:", String(e));
    factViews = [];
  }
  REG_CACHE = { retailGlob, costColumns, pgTables, dimCarry, factViews };
```

> 注意：`factViews` 的读取要放在 `try { ... } catch (e) { ... }` 的**外面**（即 `loadRegistry` 现有那个大 `try` 块之后），
> 否则它抛错会被外层 catch 吞掉并让整个注册表走 fallback —— 正是我们要避免的。

- [ ] **Step 5: `runDuckdb` 里构建通用事实视图**

在 `runDuckdb` 中，`viewSql` 拼完 `retail_detail` 与 `outbound_detail` 之后、`const combined = viewSql + "\n" + userSelect;` 之前，插入：

```js
  // 通用事实视图（注册表声明，spec §方案1）：列投影 + 行级权限裁剪
  // authKeys/allBranches 复用上面的门店授权解析结果（与 retail_detail 同一套归一）
  for (const f of (reg.factViews || [])) {
    try {
      viewSql += buildFactViewSql({
        name: f.name,
        glob: f.glob,
        scopeKeyExpr: f.scopeKeyExpr,
        columns: f.columns,
        authKeys,
        allBranches,
        canSeeCost: !!perms.fields?.cost,
      });
    } catch (e) {
      console.error("[agent-query] 构建 fact 视图失败 " + f.name + ":", String(e));
    }
  }
```

- [ ] **Step 6: 白名单派生**

在入口处，把现有这一行：

```js
  const allowedTables = ["retail_detail", "outbound_detail", ...regPre.pgTables, ...(regPre.dimCarry || []).map((d) => d.name)];
```

替换为：

```js
  const allowedTables = [
    "retail_detail",
    "outbound_detail",
    ...regPre.pgTables,
    ...(regPre.dimCarry || []).map((d) => d.name),
    ...(regPre.factViews || []).map((d) => d.name),
  ];
```

- [ ] **Step 7: 语法检查**

Run: `node --check functions/agent-query/index.js`
Expected: 无输出（语法通过）

- [ ] **Step 7b: 重新生成并提交 `index.bundle.js`（漏了这步 pre-commit 会挡，且生产跑旧代码）**

本任务同时改了 `index.js` 与新增的 `_shared/fact-view.ts`，入仓的 bundle 必然漂移。重新生成：

```bash
npx --yes esbuild functions/agent-query/index.js --bundle --format=cjs --outfile=functions/agent-query/index.bundle.js
```

Expected: 生成成功，`functions/agent-query/index.bundle.js` 内容更新（含内联的 fact-view 代码）。

自证漂移门禁可过：

```bash
bash scripts/check-functions.sh 2>&1 | grep -A1 "agent-query"
```

Expected: `✅ agent-query: 现场 bundle 合法单文件 CJS（_shared 已内联）` 且 **不出现**
`❌ agent-query: index.bundle.js 与源码最新 bundle 不一致`

- [ ] **Step 8: 全量既有单测不回归**

Run: `cd web && npm test`
Expected: PASS（与改动前同样全绿；本任务不新增 web 测试）

- [ ] **Step 9: Commit**

```bash
git add functions/agent-query/index.js functions/agent-query/index.bundle.js
git commit -m "feat(agent-query): 通用事实视图接线——注册表隔离读取 + 白名单派生

- loadFactScopes 独立请求 + 独立 try/catch：未知列 400 不得拖垮主查询
  （否则 pgTables 回退 → report_*_gen 误路由 DuckDB）
- HARDCODED_VIEW_NAMES 跳过 retail_detail/outbound_detail，存量不重构"
```

---

### Task 4: 迁移 212 —— `datasets.scope_key_expr` 列

**Files:**
- Create: `database/migrations/212_registry_fact_scope.sql`

**Interfaces:**
- Consumes: 无
- Produces: `datasets.scope_key_expr TEXT`（供 Task 3 读取、Task 5 写入）

- [ ] **Step 1: 写迁移**

创建 `database/migrations/212_registry_fact_scope.sql`：

```sql
-- 212_registry_fact_scope.sql
-- spec: docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md
-- 数据注册中心：事实数据集的「门店复合键表达式」声明列。
-- 用途：agent-query 网关据此对 kind=fact 的数据集通用构建权限视图（行级裁剪）。
-- 为空 = 不可通用构建 → 网关不建视图且不进 SQL 白名单（fail-close）。
-- 幂等：ADD COLUMN IF NOT EXISTS。
BEGIN;

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS scope_key_expr TEXT;

COMMENT ON COLUMN datasets.scope_key_expr IS
  '事实数据集的门店复合键 SQL 表达式（对本数据集注册列求值，产出归一形态 sbc-branch_num，用于行级权限裁剪）；为空=不可通用构建→ deny';

-- 源列名 → 视图列名映射（2026-09-11 加）：外部管线的列名不必与平台口径名一致。
-- 例：本行 name='system_book_code' 而 parquet 里的真实列叫 'company_id'，则 source_name='company_id'，
-- 视图投影为 "company_id" AS "system_book_code"。为空表示同名。
ALTER TABLE dataset_columns ADD COLUMN IF NOT EXISTS source_name TEXT;

COMMENT ON COLUMN dataset_columns.source_name IS
  '源 parquet 列名 → 视图列名（本行 name）的映射；为空=与 name 同名。用于外部管线列名与平台口径名不一致时，避免要求对方改名';

COMMIT;
```

- [ ] **Step 2: 本地起栈并跑迁移（验证幂等）**

按 `docs/testing-handbook.md` §3.1 起本地栈。镜像本地已存在，但**首次可能仍需登录私有仓库**（凭证见 1Password / deploy 备注）：

```bash
docker login caj9ik14016wep.xuanyuan.run
docker login registry-crs-xinan1.ctyun.cn

cd deploy
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

然后跑迁移两次，验幂等：

```bash
bash scripts/migrate.sh
bash scripts/migrate.sh   # 第二次：幂等重跑必须同样成功
```

Expected: 两次都成功结束；第二次无 `ERROR`。

> 已知本地限制（不影响本任务）：本地 `deploy/.env` 缺 `AGENT_API_KEY` / `OOS_*`，本地 DuckDB 也连不上内网 S3 端点
> ——迁移与表结构验证不受影响；「读 OSS + 建视图」只能在生产冒烟（Task 11）验。

- [ ] **Step 3: 确认列已存在**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d datasets" | grep scope_key_expr
```

Expected: 输出 `scope_key_expr | text |` 一行

- [ ] **Step 4: Commit**

```bash
git add database/migrations/212_registry_fact_scope.sql
git commit -m "feat(migration): 212 数据注册中心加 scope_key_expr——事实数据集门店复合键声明"
```

---

### Task 5: 迁移 213 —— 补货数据集注册 + 守护规则

**Files:**
- Create: `database/migrations/213_replenishment_detail_registry.sql`

**Interfaces:**
- Consumes: `datasets.scope_key_expr`（Task 4）
- Produces: `replenishment_detail` 数据集行 + 20 条列注册 + 4 条 `monitor_rules`（供 Task 7/8 的 evaluator 消费）

- [ ] **Step 1: 写迁移**

创建 `database/migrations/213_replenishment_detail_registry.sql`：

```sql
-- 213_replenishment_detail_registry.sql
-- spec: docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md
-- 补货（要货单）明细接入问数：数据集注册 + 到达/完整性守护规则。
-- 数据来源：其他系统的 duckle 管线写入
--   s3://lemeng-datasource/duckle/lemeng/replenishment_detail/<账套>/<YYYY-MM-DD>/all.parquet
-- ★ total_money 有意不注册：它是单头金额、逐行重复（实测恒等于该单 sum(subtotal)），
--   行级 SUM 会整单翻倍。视图按注册列投影 → 不注册即不可见。单头金额请按 order_no 分组 SUM(subtotal)。
-- 行级权限：scope_key_expr = 账套||'-'||门店号 归一（门店号跨账套重复，必须复合）。
-- 幂等：ON CONFLICT DO NOTHING / WHERE NOT EXISTS。
BEGIN;

-- ===== 1. 数据集行 =====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed,
                      date_column, date_format, carry_enabled, exposed, scope_key_expr, description)
VALUES (
  'replenishment_detail',
  '补货明细(要货单)',
  'duckdb_view',
  's3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet',
  'fact',
  TRUE, TRUE,
  'business_date', 'YYYY-MM-DD HH:MM:SS', FALSE, TRUE,
  'regexp_replace(system_book_code || ''-'' || branch_num, ''^([0-9]+)-0+([0-9]+)$'', ''\1-\2'')',
  '补货单(要货单)商品行；一行=一单一商品。口径：默认只算已审核生效单(state_name=''制单|审核'')，作废/未审核默认排除。金额用 SUM(subtotal)，单头金额按 order_no 分组 SUM(subtotal)。门店键必须 system_book_code+branch_num 复合（跨账套重号）'
)
-- 用 DO UPDATE 而非 DO NOTHING：否则本迁移日后修正（描述/来源/表达式）在已落库的库上会**静默 no-op**
-- ——「看起来部署了，什么也没改」。列名可枚举，全量覆写是幂等且可预期的。
ON CONFLICT (name) DO UPDATE SET
  display_name=EXCLUDED.display_name, engine=EXCLUDED.engine, source=EXCLUDED.source,
  kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime, columns_typed=EXCLUDED.columns_typed,
  date_column=EXCLUDED.date_column, date_format=EXCLUDED.date_format,
  carry_enabled=EXCLUDED.carry_enabled, exposed=EXCLUDED.exposed,
  scope_key_expr=EXCLUDED.scope_key_expr, description=EXCLUDED.description;

-- ===== 2. 列注册（视图暴露列 = 本清单；total_money intentionally absent）=====
-- data_type 取**真实 parquet 实测值**（2026-09-11 服务器 DuckDB 验证），不是沿用 lemeng 原生表的「全 VARCHAR」。
-- source_name 只给账套列用：parquet 里它叫 company_id，而平台口径名（含网关门店键守卫）必须叫 system_book_code。
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, source_name, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.source_name, v.description, v.ordinal
FROM (VALUES
  ('replenishment_detail','system_book_code','VARCHAR','维度',FALSE,'dim_branch(system_book_code,branch_num)','company_id','品牌账套：3120=熊喵鲜生 / 64188=品品甜。源列名 company_id → 视图列名 system_book_code。门店键必须与 branch_num 复合使用',1),
  ('replenishment_detail','branch_num','BIGINT','门店',FALSE,'dim_branch(system_book_code,branch_num)',NULL,'要货门店号（跨账套重号，禁止单独作 join 键）。BIGINT；与字符串拼接 DuckDB 会隐式转换',2),
  ('replenishment_detail','branch_name','VARCHAR','门店',FALSE,NULL,NULL,'要货门店名',3),
  ('replenishment_detail','out_branch_num','BIGINT','门店',FALSE,NULL,NULL,'出货方号（=99 管理中心/配送中心）',4),
  ('replenishment_detail','out_branch_name','VARCHAR','门店',FALSE,NULL,NULL,'出货方名',5),
  ('replenishment_detail','order_no','VARCHAR','单据',FALSE,NULL,NULL,'要货单号（带账套前缀 YH3120…/YH64188…，两账套不撞；与 item_num 合起来全局唯一）',6),
  ('replenishment_detail','order_type','VARCHAR','单据',FALSE,NULL,NULL,'单据类型（要货单）',7),
  ('replenishment_detail','state_name','VARCHAR','单据',FALSE,NULL,NULL,'单据状态：制单 / 制单|审核 / 制单|作废 / 制单|审核|作废。默认口径只看 ''制单|审核''',8),
  ('replenishment_detail','business_date','VARCHAR','日期',FALSE,NULL,NULL,'业务日（**全时间戳**）。按日过滤用 substr(business_date,1,10)；与分区目录名恒等（实测 0 例外）',9),
  ('replenishment_detail','create_time','VARCHAR','日期',FALSE,NULL,NULL,'制单时间',10),
  ('replenishment_detail','audit_time','VARCHAR','日期',FALSE,NULL,NULL,'审核时间（未审核单为空）',11),
  ('replenishment_detail','item_num','BIGINT','商品',FALSE,'dim_item(system_book_code,item_num)',NULL,'账套内商品编号（跨账套重号）。与 dim_item 关联必须配 system_book_code 复合成键',12),
  ('replenishment_detail','item_code','VARCHAR','商品',FALSE,'dim_item.item_code',NULL,'货来源编码（跨账套全局唯一），可单独作键',13),
  ('replenishment_detail','item_name','VARCHAR','商品',FALSE,NULL,NULL,'商品展示名。⚠禁止用 item_name 做 join 键（双账套同名不同货）',14),
  ('replenishment_detail','item_spec','VARCHAR','商品',FALSE,NULL,NULL,'规格',15),
  ('replenishment_detail','item_unit','VARCHAR','商品',FALSE,NULL,NULL,'基本单位',16),
  ('replenishment_detail','quantity','DOUBLE','数量',FALSE,NULL,NULL,'要货数量（基本单位口径）',17),
  ('replenishment_detail','use_quantity','DOUBLE','数量',FALSE,NULL,NULL,'要货数量（件数口径，配 use_unit）',18),
  ('replenishment_detail','use_unit','VARCHAR','数量',FALSE,NULL,NULL,'件单位',19),
  ('replenishment_detail','subtotal','DOUBLE','金额',FALSE,NULL,NULL,'行金额（行级求和的唯一正确列）。单头金额 = 按 order_no 分组 SUM(subtotal)',20)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, source_name, description, ordinal)
-- DO UPDATE 而非 WHERE NOT EXISTS：后者在已落库的库上会让本迁移的**后续修正静默 no-op**
-- （例如拿到换算说明后要改 quantity 的 description，会「部署成功但什么都没改」）。
ON CONFLICT (dataset_name, name) DO UPDATE SET
  data_type=EXCLUDED.data_type, semantic_group=EXCLUDED.semantic_group,
  is_sensitive=EXCLUDED.is_sensitive, join_to=EXCLUDED.join_to,
  source_name=EXCLUDED.source_name, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

-- ===== 3. 到达守护（data_freshness，runHourlyBucket 每小时）=====
-- 按账套各配一行：合计会被另一账套掩盖，必须分开看（spec §方案3）。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
VALUES
 ('补货到达·3120','data_freshness','replenishment_detail:3120',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1}'::jsonb,
  'high','🔴 [{severity}] 补货数据未到达：{dataset} 账套 {account} 缺 {expect_date} 分区（最新 {have_latest}）',1800,TRUE),
 ('补货到达·64188','data_freshness','replenishment_detail:64188',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1}'::jsonb,
  'high','🔴 [{severity}] 补货数据未到达：{dataset} 账套 {account} 缺 {expect_date} 分区（最新 {have_latest}）',1800,TRUE)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template;
-- ↑ 有意**不**写 `enabled=TRUE`：migrate.sh 每次部署全量重跑全部迁移，若这里强制回 TRUE，
--   则 spec 回滚节那条 `UPDATE monitor_rules SET enabled=false ...` 的应急抑制会在下次部署被**静默撤销**。
--   新行仍由 VALUES 里的 TRUE 正常启用；要**永久**停用则需改本迁移或删除规则行。

-- ===== 4. 行数异常守护（data_volume，runDailyBucket 每日 03:00）=====
-- 类型名用 data_volume 而非 data_integrity：后者的文档原义是「明细 count vs PG 汇总 差异率」（且已被 QA 体系承担），
-- 行数相对中位数偏离是另一根轴（数据量异常），不该占用那个槽位。见 spec §方案3。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
VALUES
 ('补货行数异常·3120','data_volume','replenishment_detail:3120',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1,"median_window":7,"deviation_pct":50,"min_samples":3}'::jsonb,
  'high','🔴 [{severity}] 补货行数异常：{dataset} 账套 {account} {date} 行数 {rows}，近 {window} 日中位数 {median}（偏离 {deviation_pct}%）',1800,TRUE),
 ('补货行数异常·64188','data_volume','replenishment_detail:64188',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1,"median_window":7,"deviation_pct":50,"min_samples":3}'::jsonb,
  'high','🔴 [{severity}] 补货行数异常：{dataset} 账套 {account} {date} 行数 {rows}，近 {window} 日中位数 {median}（偏离 {deviation_pct}%）',1800,TRUE)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template;
-- ↑ 有意**不**写 `enabled=TRUE`：migrate.sh 每次部署全量重跑全部迁移，若这里强制回 TRUE，
--   则 spec 回滚节那条 `UPDATE monitor_rules SET enabled=false ...` 的应急抑制会在下次部署被**静默撤销**。
--   新行仍由 VALUES 里的 TRUE 正常启用；要**永久**停用则需改本迁移或删除规则行。

COMMIT;
```

- [ ] **Step 2: 跑迁移（幂等验证）**

```bash
bash scripts/migrate.sh
bash scripts/migrate.sh   # 第二次必须同样成功
```

Expected: 两次成功，无 `ERROR`（本地栈已在 Task 4 起好）

- [ ] **Step 3: 确认数据集与规则落库**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT name, kind, engine, scope_key_expr FROM datasets WHERE name='replenishment_detail';"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT count(*) FROM dataset_columns WHERE dataset_name='replenishment_detail';"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT check_type, target, enabled FROM monitor_rules WHERE target LIKE 'replenishment_detail:%' ORDER BY 1,2;"
```

Expected: 1 行数据集（`scope_key_expr` 非空）；列数 `20`（其中 `system_book_code` 的 `source_name='company_id'`，其余为 NULL）；
规则 4 行（2×data_freshness + 2×data_volume，全 `t`）

- [ ] **Step 4: 确认字典能看见（且 total_money 不在）**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT jsonb_path_exists(get_data_dictionary(), '\$.**.name ? (@ == \"replenishment_detail\")');"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT count(*) FROM get_data_dictionary() AS d, jsonb_array_elements(d->'columns') c WHERE c->>'dataset_name'='replenishment_detail' AND c->>'name'='total_money';"
```

Expected: 第一条 `t`；第二条 `0`（`total_money` 未注册）

- [ ] **Step 5: 刷 PostgREST schema 缓存**

```bash
docker compose restart postgrest
```

Expected: 重启成功（否则新列经 PostgREST 不可见 → 通用路径静默降级）

- [ ] **Step 6: Commit**

```bash
git add database/migrations/213_replenishment_detail_registry.sql
git commit -m "feat(migration): 213 补货明细数据集注册 + 到达/完整性守护规则

- datasets 行含 scope_key_expr（账套||'-'||门店号 归一）
- 20 列注册；total_money 有意不注册（行级 SUM 会整单翻倍）
- 4 条 monitor_rules：data_freshness×2 + data_volume×2（按账套各配）"
```

---

### Task 6: `EvalDeps` 加 `duckdbQuery` + 修补存量 deps fake

**Files:**
- Modify: `web/lib/monitor/types.ts`（`EvalDeps` 接口）
- Modify: `web/lib/monitor/runtime.ts`（`buildDeps`）
- Modify: `web/lib/monitor/evaluators/__tests__/service-down.test.ts`
- Modify: `web/lib/monitor/evaluators/__tests__/collect-fail.test.ts`
- Modify: `web/lib/monitor/evaluators/__tests__/token-expire.test.ts`
- Modify: `web/lib/monitor/__tests__/engine.test.ts`
- Modify: `web/lib/monitor/__tests__/novu-probe.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `EvalDeps.duckdbQuery: (sql: string) => Promise<Array<Record<string, any>>>`（Task 7/8 消费）

> ⚠️ `vitest run` 用 esbuild 转译，**不做类型检查**——缺字段的 fake 在 `npm test` 里不会报错，只有 `npm run build`（tsc）才会。
> 所以本任务的验证必须是 `npm run build`。

- [ ] **Step 1: 在 `types.ts` 的 `CheckType` 联合里新增 `data_volume`**

`web/lib/monitor/types.ts` 顶部现有：

```ts
export type CheckType =
  | 'service_down'
  | 'novu_health'
  | 'token_expire'
  | 'collect_fail'
  | 'collect_stall'
  | 'request_fail'
  | 'data_freshness'
  | 'data_integrity'
  | 'contact_sync';
```

改为在 `'data_integrity'` 之后新增一行：

```ts
  | 'data_integrity'
  | 'data_volume'
```

> 为什么不复用 `data_integrity`：该类型的文档原义是「DuckDB 明细 count vs PG 汇总 差异率」，且已注明由 QA 体系承担；
> 行数相对中位数偏离是另一根轴。**`data_integrity` 保持不动**。详见 Global Constraints 的 check_type 语义裁定。

- [ ] **Step 1b: 在 `types.ts` 的 `EvalDeps` 加字段**

`web/lib/monitor/types.ts`，在 `EvalDeps` 的 `getCollectTasks` 之后追加：

```ts
  // data_freshness / data_volume 用：直接跑 DuckDB 查询（web 容器无 boto3，DuckDB 服务即现成的 OSS 出口）。
  // 返回 data 数组；非 2xx 或 success=false 时抛错（由 evaluator 决定「探测异常不报警」）。
  duckdbQuery: (sql: string) => Promise<Array<Record<string, any>>>;
```

- [ ] **Step 2: 跑 `npm run build` 确认它现在编译失败**

Run: `cd web && npm run build`
Expected: FAIL —— `Type ... is missing the following properties ...: duckdbQuery`（5 个测试文件处）

- [ ] **Step 2b: 把 `data_volume` 挂进 `runDailyBucket`（否则规则永远不会被扫到）**

`web/lib/monitor/runtime.ts` 的 `runDailyBucket` 现为：

```ts
export async function runDailyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_integrity'] as CheckType[], buildDeps(), EVALUATORS);
```

改为：

```ts
export async function runDailyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_integrity', 'data_volume'] as CheckType[], buildDeps(), EVALUATORS);
```

> `runScan` 只加载 `checkTypes` 列表内的规则——新类型不挂桶 = 规则落库也永不被评估（静默失效）。

- [ ] **Step 3: 在 `runtime.ts` 顶部加 env 常量**

`web/lib/monitor/runtime.ts` 顶部现有：

```ts
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
```

在其后追加：

```ts
// 通用事实视图守护探测用（不经 jobs/env，避免 monitor → jobs 反向依赖）
const DUCKDB_URL = process.env.DUCKDB_URL || "http://duckdb:9000";
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
```

- [ ] **Step 4: 在 `buildDeps()` 实现 `duckdbQuery`**

在 `buildDeps()` 返回对象的 `getCollectTasks` 之后追加：

```ts
    duckdbQuery: async (sql: string) => {
      const r = await fetch(`${DUCKDB_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
        body: JSON.stringify({ sql }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(`duckdb: ${d?.error || r.status}`);
      return (d.data ?? []) as Array<Record<string, any>>;
    },
```

- [ ] **Step 5: 给 5 个存量测试的 deps fake 补字段**

在每个文件的 deps 工厂对象里，`getCollectTasks: async () => [],` 之后加一行：

```ts
  duckdbQuery: async () => [],
```

涉及的 5 个文件（用 grep 定位每个文件里 deps 对象的位置）：
- `web/lib/monitor/evaluators/__tests__/service-down.test.ts`
- `web/lib/monitor/evaluators/__tests__/collect-fail.test.ts`
- `web/lib/monitor/evaluators/__tests__/token-expire.test.ts`
- `web/lib/monitor/__tests__/engine.test.ts`
- `web/lib/monitor/__tests__/novu-probe.test.ts`

定位命令：

```bash
grep -n "getCollectTasks" web/lib/monitor/evaluators/__tests__/*.test.ts web/lib/monitor/__tests__/*.test.ts
```

- [ ] **Step 6: 跑 build 确认类型通过**

Run: `cd web && npm run build`
Expected: PASS（构建成功，无 TS 报错）

- [ ] **Step 7: 跑单测确认无行为回归**

Run: `cd web && npm test`
Expected: PASS（全绿）

- [ ] **Step 8: Commit**

```bash
git add web/lib/monitor/types.ts web/lib/monitor/runtime.ts web/lib/monitor/evaluators/__tests__ web/lib/monitor/__tests__
git commit -m "feat(monitor): EvalDeps 加 duckdbQuery 依赖并注入 runtime，补齐存量 deps fake"
```

---

### Task 7: `data_freshness` evaluator —— 分区到达守护

**Files:**
- Modify: `web/lib/collect.ts`（抽出可注入 `now` 的纯日期助手）
- Create: `web/lib/monitor/evaluators/data-freshness.ts`
- Test: `web/lib/monitor/evaluators/__tests__/data-freshness.test.ts`
- Modify: `web/lib/monitor/evaluators/index.ts`

**Interfaces:**
- Consumes: `EvalDeps.duckdbQuery`（Task 6）
- Produces:
  - `export function chinaDateAt(base: Date, offsetDays: number): string`（新增于 `web/lib/collect.ts`，Task 8 也消费）
  - `export const evalDataFreshness: Evaluator`

- [ ] **Step 1: Write the failing test**

创建 `web/lib/monitor/evaluators/__tests__/data-freshness.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { evalDataFreshness } from '../data-freshness';
import type { MonitorRule, EvalDeps } from '../../types';

const GLOB = 's3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet';

const rule = (target: string, lookback = 1): MonitorRule => ({
  id: 1,
  name: `补货到达·${target}`,
  check_type: 'data_freshness',
  target,
  threshold: { dataset: 'replenishment_detail', glob_template: GLOB, lookback_days: lookback },
  severity: 'high',
  touser: null,
  template: '缺 {expect_date}',
  suppress_window_seconds: 1800,
  enabled: true,
});

// now = 2026-09-11 10:00 UTC → 中国时间 2026-09-11 18:00 → 昨日(中国) = 2026-09-10
const deps = (rows: Array<{ d: string }>, throwErr?: string): EvalDeps => ({
  now: new Date('2026-09-11T10:00:00Z'),
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => null,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
  duckdbQuery: async () => {
    if (throwErr) throw new Error(throwErr);
    return rows;
  },
});

describe('evalDataFreshness', () => {
  it('昨日分区存在 → 不 firing', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10' }, { d: '2026-09-09' }]));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('data_freshness:replenishment_detail:3120');
  });

  it('昨日分区缺失 → firing + context', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([{ d: '2026-09-05' }, { d: '2026-09-04' }]));
    expect(r.firing).toBe(true);
    expect(r.context).toMatchObject({
      dataset: 'replenishment_detail',
      account: '3120',
      expect_date: '2026-09-10',
      have_latest: '2026-09-05',
    });
  });

  it('一个分区都没有 → firing，have_latest=none', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:64188'), deps([]));
    expect(r.firing).toBe(true);
    expect(r.context.have_latest).toBe('none');
  });

  it('探测异常 → 不 firing（不误报；duckdb 本体故障由 service_down 桶负责）', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120'), deps([], 'ECONNREFUSED'));
    expect(r.firing).toBe(false);
  });

  it('target 格式非法 → 不 firing（不瞎报）', async () => {
    const r = await evalDataFreshness(rule('bogus'), deps([]));
    expect(r.firing).toBe(false);
  });

  it('lookback_days=2 时看前天', async () => {
    const r = await evalDataFreshness(rule('replenishment_detail:3120', 2), deps([{ d: '2026-09-10' }]));
    expect(r.firing).toBe(true);
    expect(r.context.expect_date).toBe('2026-09-09');
  });

  it('账套被代入 glob（不同账套各查各的）', async () => {
    let seen = '';
    const d = deps([]);
    d.duckdbQuery = async (sql: string) => {
      seen = sql;
      return [];
    };
    await evalDataFreshness(rule('replenishment_detail:64188'), d);
    expect(seen).toContain('replenishment_detail/64188/');
    expect(seen).not.toContain('{account}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/data-freshness.test.ts`
Expected: FAIL —— `Failed to resolve import "../data-freshness"`

- [ ] **Step 3: Write minimal implementation**

**三步。**

**第 1 步：抽出可注入的纯日期助手**——`web/lib/collect.ts` 已有的 `getDateOffsetChina(offsetDays)` 内部调 `new Date()`，无法用 `deps.now` 注入，单测不可确定。把它重构成「纯函数 + 保持原函数行为不变的包装」：

`web/lib/collect.ts` 中找到：

```ts
export function getDateOffsetChina(offsetDays: number): string {
  const now = new Date();
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  china.setDate(china.getDate() + offsetDays);
  return china.toISOString().split('T')[0];
}
```

替换为：

```ts
// 中国时区（UTC+8，无夏令时）下 base 偏移 offsetDays 天的日期，YYYY-MM-DD。
// 抽成纯函数以便单测注入确定的时间基准（守护 evaluator 用 deps.now）。
export function chinaDateAt(base: Date, offsetDays: number): string {
  const china = new Date(base.getTime() + 8 * 60 * 60 * 1000);
  china.setDate(china.getDate() + offsetDays);
  return china.toISOString().split('T')[0];
}

export function getDateOffsetChina(offsetDays: number): string {
  return chinaDateAt(new Date(), offsetDays);
}
```

> 行为等价性：`new Date(now.getTime() + 8h)` 后再 `setDate(getDate() + offset)` 与原实现逐字相同，只是把 `now` 变成入参。

**第 2 步：新建共享的 SQL 转义助手**（两个 evaluator 共用一份，不各留一份）：

创建 `web/lib/monitor/evaluators/sql.ts`：

```ts
// monitor evaluator 共享的 SQL 字面量转义。
// 不跨包复用 functions/_shared/fact-view.ts 的 sqlLit：那是 Deno edge function 运行时的模块，
// 被 Next.js web 侧 import 会造成错误的运行时耦合；两侧各留一份、各自单测锁定。
export function sqlLit(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
```

**第 3 步：创建** `web/lib/monitor/evaluators/data-freshness.ts`：

```ts
import type { EvalDeps, EvalResult, Evaluator } from '../types';
import { chinaDateAt } from '../../collect';
import { sqlLit } from './sql';

// 数据到达守护（spec 2026-09-11-replenishment-detail-query-onboarding-design §方案3）
// 背景：外部 duckle 管线写入 OSS 的补货数据曾出现 10 天断档，且无人发现——消费侧必须自己发现。
// rule.target = '<dataset>:<账套>'；threshold = {dataset, glob_template(含 {account}), lookback_days}
// 判据：期望业务日（中国时区 now - lookback_days）的分区不存在 → firing。
// 探测异常不报警：duckdb 本体故障由 service_down 桶负责，避免双报。
// context = {dataset, account, expect_date, have_latest}

export const evalDataFreshness: Evaluator = async (
  rule,
  deps: EvalDeps,
): Promise<EvalResult> => {
  const t = (rule.threshold ?? {}) as Record<string, any>;
  const target = String(rule.target ?? '');
  const alertKey = `data_freshness:${target}`;
  const [dataset, account] = target.split(':');
  if (!dataset || !account) {
    return { firing: false, alert_key: alertKey, context: { reason: 'bad_target' } };
  }
  const lookback = Number(t.lookback_days ?? 1);
  const glob = String(t.glob_template ?? '').replace('{account}', account);
  const expectDate = chinaDateAt(deps.now, -lookback);

  let rows: Array<{ d: string }>;
  try {
    rows = (await deps.duckdbQuery(
      `SELECT DISTINCT regexp_extract(filename, '/([0-9-]{10})/', 1) AS d ` +
        `FROM read_parquet(${sqlLit(glob)}, filename=true)`,
    )) as Array<{ d: string }>;
  } catch (e) {
    console.error(`[monitor] data_freshness 探测异常 ${target}:`, (e as Error)?.message ?? e);
    return { firing: false, alert_key: alertKey, context: { reason: 'probe_error' } };
  }

  const dates = (rows ?? []).map((r) => r.d).filter(Boolean).sort();
  const firing = !dates.includes(expectDate);
  return {
    firing,
    alert_key: alertKey,
    context: {
      dataset,
      account,
      expect_date: expectDate,
      have_latest: dates.length ? dates[dates.length - 1] : 'none',
      // ★ severity 必须注入：模板里的 `🔴 [{severity}]` 只在 `key in context` 时才会被替换
      //   （web/lib/monitor/lifecycle.ts renderTemplate），否则告警正文会出现**字面量** `[{severity}]`。
      //   既有那 8 条种子规则（020/022）就带着这个字面量——不要跟着坏，我们的规则自己注入。
      severity: rule.severity,
    },
  };
};
```

- [ ] **Step 4: 注册进 `EVALUATORS`**

`web/lib/monitor/evaluators/index.ts`，在 import 区加：

```ts
import { evalDataFreshness } from './data-freshness';
```

并在 `EVALUATORS` 对象里加一行：

```ts
  data_freshness: evalDataFreshness,
```

**顺带收口文档状态（Task 1 交接项）**：Task 1 的修复轮已把 §8.1 表格里 `data_freshness` 行的「数据源/触发」
**拓宽**为兼容两种含义（①通用陈旧度 ②外部数据集分区到达），状态仍是 ⏳ 未实现。本任务让它真正实现，
**把该行的状态列改为已实现**。改前先 `grep -n "data_freshness" docs/architecture.md` 定位；只改状态单元格，不动表格结构。

> ⚠️ **本任务不要动 §8.1 引擎拓扑行与 §十一 的汇总计数行**（「已实现 4/8」「监控待实现 4 项」）。
> 那些是聚合口径，`data_volume` 落地后才成立，统一由 **Task 8 Step 5b** 收口——避免同一行被改两次、
> 中途出现一个必然不对的数字。

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/data-freshness.test.ts`
Expected: PASS（8 个用例全绿）

- [ ] **Step 6: Commit**

```bash
git add web/lib/collect.ts web/lib/monitor/evaluators/sql.ts web/lib/monitor/evaluators/data-freshness.ts web/lib/monitor/evaluators/__tests__/data-freshness.test.ts web/lib/monitor/evaluators/index.ts docs/architecture.md
git commit -m "feat(monitor): data_freshness evaluator——外部管线数据到达守护（探测异常不误报）

顺带把 collect.ts 的中国时区日期逻辑抽成可注入的纯函数 chinaDateAt（行为等价）"
```

---

### Task 8: `data_volume` evaluator —— 行数异常守护

**Files:**
- Create: `web/lib/monitor/evaluators/data-volume.ts`
- Test: `web/lib/monitor/evaluators/__tests__/data-volume.test.ts`
- Modify: `web/lib/monitor/evaluators/index.ts`

**Interfaces:**
- Consumes: `EvalDeps.duckdbQuery`（Task 6）、`chinaDateAt(base, offsetDays)`（Task 7 新增于 `web/lib/collect.ts`）、`sqlLit`（`./sql`，Task 7 新建）
- Produces: `export const evalDataVolume: Evaluator`

> **类型名是 `data_volume` 不是 `data_integrity`**：后者文档原义为「明细 count vs PG 汇总 差异率」（已被 QA 体系承担），
> 行数相对中位数偏离是另一根轴。见 Global Constraints 的 check_type 语义裁定。不要"顺手"改回去。

- [ ] **Step 1: Write the failing test**

创建 `web/lib/monitor/evaluators/__tests__/data-volume.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { evalDataVolume } from '../data-volume';
import type { MonitorRule, EvalDeps } from '../../types';

const GLOB = 's3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet';

const rule = (target: string, extra: Record<string, any> = {}): MonitorRule => ({
  id: 1,
  name: `补货行数异常·${target}`,
  check_type: 'data_volume',
  target,
  threshold: {
    dataset: 'replenishment_detail',
    glob_template: GLOB,
    lookback_days: 1,
    median_window: 7,
    deviation_pct: 50,
    min_samples: 3,
    ...extra,
  },
  severity: 'high',
  touser: null,
  template: '行数 {rows} vs 中位 {median}',
  suppress_window_seconds: 1800,
  enabled: true,
});

// now = 2026-09-11 10:00 UTC → 中国 2026-09-11 → 昨日 = 2026-09-10
const deps = (rows: Array<{ d: string; n: number }>, throwErr?: string): EvalDeps => ({
  now: new Date('2026-09-11T10:00:00Z'),
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => null,
  getCollectLogs: async () => [],
  getCollectTasks: async () => [],
  duckdbQuery: async () => {
    if (throwErr) throw new Error(throwErr);
    return rows;
  },
});

const WEEK = [
  { d: '2026-09-09', n: 580 },
  { d: '2026-09-08', n: 575 },
  { d: '2026-09-07', n: 520 },
  { d: '2026-09-06', n: 531 },
  { d: '2026-09-05', n: 612 },
];

describe('evalDataVolume', () => {
  it('昨日行数正常 → 不 firing', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 589 }, ...WEEK]));
    expect(r.firing).toBe(false);
    expect(r.alert_key).toBe('data_volume:replenishment_detail:3120');
  });

  it('昨日行数骤降（半截数据）→ firing + context', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 40 }, ...WEEK]));
    expect(r.firing).toBe(true);
    expect(r.context).toMatchObject({ account: '3120', date: '2026-09-10', rows: 40 });
    expect(Number(r.context.deviation_pct)).toBeGreaterThan(50);
  });

  it('昨日行数暴涨 → firing', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 5000 }, ...WEEK]));
    expect(r.firing).toBe(true);
  });

  it('样本不足（< min_samples）→ 不 firing（冷启动保护）', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([{ d: '2026-09-10', n: 3 }, { d: '2026-09-09', n: 580 }]));
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'insufficient_samples' });
  });

  it('昨日分区不存在 → 不 firing（交由 data_freshness 负责）', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps(WEEK));
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'no_data_for_date' });
  });

  it('中位数为 0 → 不 firing（防除零）', async () => {
    const r = await evalDataVolume(
      rule('replenishment_detail:3120'),
      deps([{ d: '2026-09-10', n: 10 }, { d: '2026-09-09', n: 0 }, { d: '2026-09-08', n: 0 }, { d: '2026-09-07', n: 0 }]),
    );
    expect(r.firing).toBe(false);
    expect(r.context).toMatchObject({ reason: 'zero_median' });
  });

  it('探测异常 → 不 firing', async () => {
    const r = await evalDataVolume(rule('replenishment_detail:3120'), deps([], 'ECONNREFUSED'));
    expect(r.firing).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/data-volume.test.ts`
Expected: FAIL —— `Failed to resolve import "../data-volume"`

- [ ] **Step 3: Write minimal implementation**

创建 `web/lib/monitor/evaluators/data-volume.ts`：

```ts
import type { EvalDeps, EvalResult, Evaluator } from '../types';
import { chinaDateAt } from '../../collect';
import { sqlLit } from './sql';

// 数据量异常守护（spec 2026-09-11-replenishment-detail-query-onboarding-design §方案3）
// 类型名 data_volume：与 data_integrity（明细 vs 汇总差异率，已被 QA 体系承担）是不同轴，不要混用。
// 目的：抓「半截数据静默入库」——分区到了但行数骤降（如分页中断只写了一部分）。
// rule.target = '<dataset>:<账套>'；threshold = {dataset, glob_template, lookback_days,
//   median_window, deviation_pct, min_samples}
// 判据：期望业务日行数 vs 之前 median_window 个有数日的中位数，偏离 > deviation_pct% → firing。
// 冷启动：样本 < min_samples → 不判（防历史回补期误报）。
// 探测异常不报警（同 data_freshness：duckdb 本体故障归 service_down 桶）。
// context = {dataset, account, date, rows, median, window, deviation_pct}

function median(nums: number[]): number {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export const evalDataVolume: Evaluator = async (
  rule,
  deps: EvalDeps,
): Promise<EvalResult> => {
  const t = (rule.threshold ?? {}) as Record<string, any>;
  const target = String(rule.target ?? '');
  const alertKey = `data_volume:${target}`;
  const [dataset, account] = target.split(':');
  if (!dataset || !account) {
    return { firing: false, alert_key: alertKey, context: { reason: 'bad_target' } };
  }
  const lookback = Number(t.lookback_days ?? 1);
  const windowSize = Number(t.median_window ?? 7);
  const deviationPct = Number(t.deviation_pct ?? 50);
  const minSamples = Number(t.min_samples ?? 3);
  const glob = String(t.glob_template ?? '').replace('{account}', account);
  const expectDate = chinaDateAt(deps.now, -lookback);

  let rows: Array<{ d: string; n: number }>;
  try {
    rows = (await deps.duckdbQuery(
      `SELECT regexp_extract(filename, '/([0-9-]{10})/', 1) AS d, count(*) AS n ` +
        `FROM read_parquet(${sqlLit(glob)}, filename=true) GROUP BY 1`,
    )) as Array<{ d: string; n: number }>;
  } catch (e) {
    console.error(`[monitor] data_volume 探测异常 ${target}:`, (e as Error)?.message ?? e);
    return { firing: false, alert_key: alertKey, context: { reason: 'probe_error' } };
  }

  const byDate = new Map((rows ?? []).map((r) => [String(r.d), Number(r.n)]));
  const todayRows = byDate.get(expectDate);
  if (todayRows === undefined) {
    return { firing: false, alert_key: alertKey, context: { reason: 'no_data_for_date', date: expectDate } };
  }
  const history = [...byDate.entries()]
    .filter(([d]) => d < expectDate)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, windowSize)
    .map(([, n]) => n);
  if (history.length < minSamples) {
    return {
      firing: false,
      alert_key: alertKey,
      context: { reason: 'insufficient_samples', date: expectDate, samples: history.length },
    };
  }
  const med = median(history);
  if (med <= 0) {
    return { firing: false, alert_key: alertKey, context: { reason: 'zero_median', date: expectDate } };
  }
  const dev = Math.round((Math.abs(todayRows - med) / med) * 100);
  return {
    firing: dev > deviationPct,
    alert_key: alertKey,
    context: {
      dataset,
      account,
      date: expectDate,
      rows: todayRows,
      median: med,
      window: history.length,
      deviation_pct: dev,
      // ★ 同 data_freshness：模板里 `🔴 [{severity}]` 需要 context 提供 severity 才会被替换，
      //   否则告警正文出现字面量 `[{severity}]`。
      severity: rule.severity,
    },
  };
};
```

- [ ] **Step 4: 注册进 `EVALUATORS`**

`web/lib/monitor/evaluators/index.ts`，import 区加：

```ts
import { evalDataVolume } from './data-volume';
```

`EVALUATORS` 对象里加一行：

```ts
  data_volume: evalDataVolume,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run lib/monitor/evaluators/__tests__/data-volume.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5b: 收口 `docs/architecture.md` 里全部 check_type 引用（三处）**

`data_volume` 是**新增**的 check_type，文档里有三处需要同步（前两处是 Task 1 修复轮未能授权的连带项）：

```bash
grep -n "data_volume\|data_freshness\|已实现 4/8\|待实现" docs/architecture.md
```

1. **§8.1 `check_type` 清单表格**：Task 1 修复轮已新增 `data_volume` 行（初始 ⏳ 未实现），
   本任务让它真正实现 → **把该行状态列改为 ✅ 已实现**。只改状态单元格。
   同时确认 `data_integrity` 行仍是 ⏳ 未实现（它本就没实现，**不要顺手改**）。
2. **§8.1 引擎拓扑行**（约 978 行）现为「… / 每日 `data_integrity`。」→ 改为「… / 每日 `data_integrity`·`data_volume`。」。
3. **§十一 实现状态汇总**（约 1436-1437 行）两行：
   - 「监控告警体系 v1 | 🔶 部分实现 | 已实现 **4/8**：…；未实现：request_fail/**data_freshness**/**data_integrity**/contact_sync」
     → 改为「已实现 **6/9**：token_expire/collect_fail/service_down/collect_stall/**data_freshness**/**data_volume**；
     未实现：request_fail/data_integrity/contact_sync」（分母 8→9 因为新增了 `data_volume`）。
   - 「监控待实现 **4 项** evaluator」→ 改为「**3 项**」。

> **为什么全放在本任务**：这三处的聚合口径（清单数量/总数）只有在两个 evaluator 都落地后才成立。
> 若 Task 7 也动汇总行，同一行会被改两次且中途数字必然有一处不对。故 Task 7 **只翻自己那一行表格状态**，
> 汇总计数统一在此收口。

- [ ] **Step 6: 全量单测 + 类型检查**

Run: `cd web && npm test && npm run build`
Expected: 都 PASS

- [ ] **Step 7: Commit**

```bash
git add web/lib/monitor/evaluators/data-volume.ts web/lib/monitor/evaluators/__tests__/data-volume.test.ts web/lib/monitor/evaluators/index.ts docs/architecture.md
git commit -m "feat(monitor): data_volume evaluator——外部管线行数骤降守护（含冷启动保护）

新增 CheckType data_volume 并挂进 runDailyBucket；data_integrity 保持未实现不动
（其原义为明细 vs 汇总差异率，已由 QA 体系承担）"
```

---

### Task 9: SKILL.md 补货模板

**Files:**
- Modify: `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

**Interfaces:**
- Consumes: Task 5 注册的 `replenishment_detail` 数据集
- Produces: 无（模型侧提示词）

- [ ] **Step 1: 读现有模板库末尾，确定插入位置**

Run: `grep -n "^\*\*[⑨⑩⑪⑫]" openclaw/data-query-plugin/skills/retail-query/SKILL.md`
Expected: 看到⑨⑩⑪ 的现有编号（若最高编号不是⑪，用实际的下一个编号，不要跳号）

- [ ] **Step 2: 在模板库末尾追加补货模板**

在 SKILL.md 模板库最后一条模板之后追加（编号按 Step 1 的实际下一个）：

```markdown
**⑫ 补货/要货单明细（replenishment_detail）**
口径（**模板硬编码，勿改**）：默认只算**已审核生效**的要货单 → `WHERE state_name='制单|审核'`；
作废单（`含作废`）与未审核单（仅 `制单`）默认排除。用户明确问「要货需求/未审要货」时才放开过滤。
写法要点：金额一律 `SUM(subtotal)`；**没有 `total_money` 这一列**（单头金额按 order_no 分组 SUM(subtotal)）；
`business_date` 是时间戳 → 按日过滤用 `substr(business_date,1,10)`；
门店键必须 `system_book_code + branch_num` 复合（跨账套重号）；商品 join 必须 `dim_item.system_book_code + item_num` 复合。
> 数据覆盖：自 2026-08-25 起（9/5 之后连续）。**问跨期问题前先说明可用范围**，不要对缺数区间给出结论。

```sql
-- 门店补货额排行
SELECT branch_name, SUM(subtotal) amt, COUNT(DISTINCT order_no) orders
FROM replenishment_detail
WHERE state_name='制单|审核' AND substr(business_date,1,10) >= '2026-09-05'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- 单品补货量（配商品档案；必须复合键 join）
SELECT di.item_name, SUM(r.quantity) qty, SUM(r.subtotal) amt
FROM replenishment_detail r
JOIN dim_item di ON di.system_book_code = r.system_book_code AND di.item_num = r.item_num
WHERE r.state_name='制单|审核' AND substr(r.business_date,1,10) >= '2026-09-05'
GROUP BY 1 ORDER BY 3 DESC LIMIT 10;

-- 品牌对比
SELECT system_book_code, SUM(subtotal) amt
FROM replenishment_detail
WHERE state_name='制单|审核' AND substr(business_date,1,10) >= '2026-09-05'
GROUP BY 1 ORDER BY 2 DESC;
```
```

- [ ] **Step 3: 校验模板编号不重复、SQL 与网关守卫相容**

Run: `grep -c "replenishment_detail" openclaw/data-query-plugin/skills/retail-query/SKILL.md`
Expected: ≥ 4（模板标题 + 3 条 SQL 各一次）

人工核对：模板里的 JOIN 子句必须同时含 `system_book_code` 与 `item_num`（否则会被 `assertItemJoin` 拒）；模板里不得出现 `total_money`。

Run: `grep -c "total_money" openclaw/data-query-plugin/skills/retail-query/SKILL.md`
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add openclaw/data-query-plugin/skills/retail-query/SKILL.md
git commit -m "feat(skill): 补货/要货单明细查询模板⑫（口径硬编码 + 复合键 + 禁用 total_money）"
```

---

### Task 9b: 真实 parquet 干跑（**部署前必做**）

**为什么必须做**：本机 DuckDB 连不上内网 S3，所以「视图能否对着**真实数据**建起来」在本机**测不出来**。
第一版注册值就是带着 `Binder Error: Referenced column "system_book_code" not found` 一路通过评审的
（parquet 里叫 `company_id`）——若留到生产冒烟才发现，**整个功能零可用**。

**★ 必须调用真实的 `buildFactViewSql`，不许手搓 SQL。**
手搓的话人会按真实列名写对，反而把这个 bug 掩盖掉——这正是它能溜过三轮评审的原因。

**Files:**
- 无仓库文件改动（全过程在临时目录 + 服务器只读查询）

**Interfaces:**
- Consumes: Task 2 的 `buildFactViewSql`、Task 5 已落库的 `datasets`/`dataset_columns` 行
- Produces: 一份干跑结论（贴进 PR 评论 / 报告）

- [ ] **Step 1: 从本地库读出注册值（Task 5 已落库）**

本地栈在跑（Task 4 起好的）。读真实注册行，不要照抄计划文本：

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge <<'SQL'
SELECT name, source, kind, engine, scope_key_expr FROM datasets WHERE name='replenishment_detail';
SELECT name, is_sensitive, source_name FROM dataset_columns WHERE dataset_name='replenishment_detail' ORDER BY ordinal;
SQL
```

- [ ] **Step 2: 用真实函数生成视图 SQL（不是手写）**

```bash
cd "/Users/duo/orca/workspaces/data-analysis/补货数据采集管线接入"
npx --yes esbuild functions/_shared/fact-view.ts --bundle --format=cjs --outfile=/tmp/fv.js
```

然后写一个临时脚本 `/tmp/dryrun.js`，把 **Step 1 查出来的真实注册值**喂给真实函数，并打印 SQL：

```js
const { buildFactViewSql } = require('/tmp/fv.js');
// ↓ 这三个数组的内容必须逐字来自 Step 1 的查询结果，不要凭计划文本填写
const columns = [
  /* { name, sensitive, sourceName? } ... */
];
const sql = buildFactViewSql({
  name: 'replenishment_detail',
  glob: 's3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet',
  scopeKeyExpr: /* Step 1 查到的 scope_key_expr 原文 */ '',
  columns,
  authKeys: ['3120-7', '3120-1'],  // 单账套窄授权：验行过滤真的收窄
  allBranches: false,
  canSeeCost: false,
});
console.log(sql);
```

```bash
node /tmp/dryrun.js > /tmp/dryrun.sql && cat /tmp/dryrun.sql
```

- [ ] **Step 3: 把生成的 SQL 拿到服务器上对着真实 OSS 跑（只读）**

服务器有 OSS 访问权限、本地没有。**只读查询，不得写入或改动任何东西。**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com '
export D=$(docker exec deploy-duckdb-1 printenv S3_ENDPOINT | sed "s|http://||")
export AK=$(docker exec deploy-duckdb-1 printenv S3_ACCESS_KEY)
export SK=$(docker exec deploy-duckdb-1 printenv S3_SECRET_KEY)
# 把 /tmp/dryrun.sql 内容贴进来，前面加 SET s3_* 四行，末尾追加验证查询
'
```

**必须回答的问题（逐条给实测结果，不许"应该可以"）**：

1. **视图建得起来吗？** —— `CREATE OR REPLACE TEMP VIEW ...` 是否报 `Binder Error`？报错就说明列名/类型对不上，**停在这里回去改注册值**。
2. **能查吗？** —— `SELECT count(*) FROM replenishment_detail;` 是否成功、返回多少行？
3. **行过滤真的收窄了吗？** —— 同一视图分别用 `authKeys=['3120-7']` 与 `allBranches=true` 各查一次
   `count(*)` 与 `count(DISTINCT system_book_code || '-' || branch_num)`，**窄授权严格小于全量**且非空。
4. **键形态对吗？** —— 窄授权下 `SELECT DISTINCT system_book_code || '-' || branch_num ... LIMIT 5` 是否产出 `3120-7` 形态（而非 `company_id` 或空）。

- [ ] **Step 4: 清理临时文件**

```bash
rm -f /tmp/fv.js /tmp/dryrun.js /tmp/dryrun.sql
```

- [ ] **Step 5: 记录结论**

把 4 条的**实测输出原文**写进
`/Users/duo/orca/workspaces/data-analysis/补货数据采集管线接入/.superpowers/sdd/2026-09-11-replenishment-detail-query-onboarding/task-9b-report.md`
（这是部署的**放行条件**：4 条全部通过才可进 Task 10）。

---

### Task 10: 部署（严格按 Global Constraints 的次序）

**Files:** 无（部署动作）

**Interfaces:**
- Consumes: Task 1-9 的全部产物
- Produces: 生产环境可用的 `replenishment_detail`

> ⚠️ 本任务次序不可调换。第 2 步必须早于第 5 步：注册行一落地，字典立刻对模型可见，
> 此时 function 必须已能建视图，否则模型会「看得见查不了」→ 撞 `forbidden_table` → 转而自由发挥。

- [ ] **Step 0: 放行门禁 —— 确认 Task 9b 的真实 parquet 干跑 4 条全过**

**不通过就不许部署。** 回看 `task-9b-report.md`，四条（视图建得起来 / 能查 / 行过滤真的收窄 / 键形态正确）
必须有**实测输出原文**。这是本项目唯一能在部署前发现「列名/类型对不上」的关卡——本机没有 OSS 访问，测不出。

- [ ] **Step 1: 合并 PR 并部署架构文档**

```bash
git push origin HEAD
gh pr create --fill
gh pr merge --squash --delete-branch
```

Expected: PR 合并触发 GHA 完整部署（含迁移 212/213）

> 若按仓库惯例 function 与前端分开部署：`functions/` 改动走 GHA，`openclaw/` **不走 GHA**（手动 SSH，见 Step 6）。

- [ ] **Step 2: 确认 function 已上新（先于注册行生效）**

```bash
curl -s https://data.shanhaiyiguo.com/api/health
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H 'Content-Type: application/json' \
  -d '{"mode":"dictionary"}'
```

Expected: health OK；dictionary 返回 200。此步**只看 function 是否在跑**，不看 `replenishment_detail` 是否已出现——
注册行可能还没落库（迁移尚未跑），这不影响本步通过。

- [ ] **Step 3: 等 GHA 绿，确认迁移 212/213 已执行**

```bash
gh run list --limit 3
gh run watch <run-id>
```

Expected: 5 个 step 全绿

- [ ] **Step 4: 清 Deno 缓存（function 改动生效的关键步，否则跑旧代码）**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 5: 刷 PostgREST schema 缓存（新列可见的关键步）**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 6: 部署 SKILL.md（openclaw 是手动 SSH 部署面）**

```bash
scp -r openclaw/data-query-plugin \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker restart deploy-openclaw-1"
```

Expected: 容器重启成功

- [ ] **Step 7: 确认守护规则已被拾取（evaluator 上线后首个整点）**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com \
  "docker logs deploy-web-1 --since 70m 2>&1 | grep -i 'monitor' | tail -20"
```

Expected: **不再出现** `[monitor] 无 data_freshness evaluator，跳过规则 补货到达·3120`。
若仍出现 → evaluator 未生效，回到 Step 1 检查 web 镜像是否更新。

---

### Task 11: 生产冒烟 —— 权限断言 + 准确性对账

**Files:** 无（验收动作）

**Interfaces:**
- Consumes: Task 10 的部署结果
- Produces: 验收结论（记录到 PR 评论或 changelog 行）

> 这是「准确」的最终判据。**不通过就不算完成。**

- [ ] **Step 1: 基本可用性冒烟**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H 'Content-Type: application/json' \
  -d '{"userId":"ZhangDuo","agent_api_key":"<deploy/.env 的 AGENT_API_KEY>","sql":"SELECT system_book_code, COUNT(*) AS n, ROUND(SUM(subtotal),2) AS amt FROM replenishment_detail GROUP BY 1 ORDER BY 1"}'
```

Expected: 返回 2 行（3120 / 64188），且 `n` 与 OSS 实况一致（2026-09-11 实测：3120=3772、64188=1094；注意当日分区为部分数据，行数会随时间增长）。

- [ ] **Step 2: 断言「未注册列不可见」（total_money 已被拿掉）**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H 'Content-Type: application/json' \
  -d '{"userId":"ZhangDuo","agent_api_key":"<AGENT_API_KEY>","sql":"SELECT total_money FROM replenishment_detail LIMIT 1"}'
```

Expected: HTTP 500 + `error` 含 `Binder Error` / `total_money`（列不存在）——即「拿掉」生效

- [ ] **Step 3: 断言「注册表故障不退化路由」**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H 'Content-Type: application/json' \
  -d '{"userId":"ZhangDuo","agent_api_key":"<AGENT_API_KEY>","sql":"SELECT COUNT(*) FROM report_daily_sales"}'
```

Expected: 返回成功且 `engine` 为 `"pg"`（证明 `pgTables` 未退化为 3 张表）

- [ ] **Step 4: 权限断言 —— 窄授权行集严格 ⊂ 全量行集**

按 `docs/testing-handbook.md` §3.4「直接 POST `{sql, userId, agent_api_key}` 模拟不同 userId」：

选两个授权范围不同的真实用户（A = 全量，B = 窄单店/单部门），分别执行同一查询：

```bash
# 对 A、B 各跑一次，记录行数与门店集合
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<A_全量>","agent_api_key":"<AGENT_API_KEY>","sql":"SELECT system_book_code, branch_num, COUNT(*) AS n FROM replenishment_detail GROUP BY 1,2 ORDER BY 1,2"}'
```

断言：
1. B 的门店集合 **严格 ⊂** A 的门店集合（**不等**、**非空**）
2. B 里**不同时出现**两个账套的同号 `branch_num`（跨账套不串）
3. 若 B 的行数与 A 完全相同 → **立即停止**：说明 `scope_key_expr` 塌缩（越权），回 Task 5 检查表达式

- [ ] **Step 5: 空授权 fail-close 断言**

找一个无任何门店授权的账号（或临时构造），执行 Step 4 的查询。

Expected: 0 行（`WHERE 1=0`），**不是**全量 —— 这是 fail-close 的实证

- [ ] **Step 6: 准确性对账 —— 与 Lemeng 要货单页面比数**

在 Lemeng 后台打开要货单查询（同口径：已审核、非作废），选一个确定日期（如 2026-09-10）+ 单账套：

```
对账 SQL（账套 × 日期 × 金额）：
SELECT COUNT(DISTINCT order_no) AS orders, ROUND(SUM(subtotal),2) AS amt
FROM replenishment_detail
WHERE system_book_code='3120' AND state_name='制单|审核' AND substr(business_date,1,10)='2026-09-10';
```

Expected: `orders` 与 `amt` 与 Lemeng 页面**分毫一致**。

按 spec 的验收标准：**任一维度不一致即视为未通过**，须定位到口径差异（作废/未审/单位）后重跑。差异若来自口径定义，回 Task 5 改模板/字典，不要改视图绕过。

- [ ] **Step 7: 守护可用性冒烟（人工触发一次缺失场景）**

在确认 `data_freshness` evaluator 已注册后，临时把某条规则的 `target` 改成一个不存在的账套（如 `replenishment_detail:9999`），等下一个整点：

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "UPDATE monitor_rules SET target='replenishment_detail:9999' WHERE name='补货到达·3120';"
```

Expected: 企微收到 `补货数据未到达：replenishment_detail 账套 9999 缺 <日期> 分区`。验证后改回：

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "UPDATE monitor_rules SET target='replenishment_detail:3120' WHERE name='补货到达·3120';"
```

- [ ] **Step 8: 记录验收结论**

在 PR 评论里记录：Step 1 行数、Step 4 的 A/B 行数、Step 6 的对账数字。若走 changelog，加一行：

```
【新增】补货(要货单)明细接入智能问数：注册表通用事实视图（datasets.scope_key_expr）+ 到达/行数守护（data_freshness/data_volume）
```

---

## 依赖与阻塞

- ⏳ **其他系统回补历史到 2026-07-01** —— 这是数据契约侧的前置项（spec 第 1 节），**不阻塞本计划的代码实施**，但阻塞「跨期问答准确」这一目标。
  回补完成前，Task 9 写入的 SKILL.md 已标注可用范围 `2026-08-25 起（9/5 后连续）`，模型会主动声明覆盖范围。
- ⏳ `quantity` ↔ `use_quantity` 换算说明 —— 影响「补货量」默认列的口径表述（当前字典把 `quantity` 描述为基本单位口径）。拿到说明后按需更新 `dataset_columns.description`。
- 📌 关联调出单号（要货 vs 实发满足率）—— 属增量能力，不在本计划范围。
