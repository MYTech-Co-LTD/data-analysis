# C1 compute 层收口 + 自动重算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三套 C1 收口为一套配置驱动的 c1-runner（复刻 C0），C1 diff 自动 /compute 重算 ≤3 次，删 reconcile-check.js/cron-reconcile.sh/route，保留 09:07 粗筛。

**Architecture:** c1.ts 对账（明细 duck vs 聚合 pg，sbc|bizday，amt+profit）+ c1-runner（遍历 detailSources + 自动重算 retry）+ qa-runner 注入（同 C0）+ detail-sources 加 report_type + scheduler 采集后追加。

**Tech Stack:** TypeScript / DuckDB HTTP / PostgREST / vitest / GHA

**Spec:** `docs/superpowers/specs/2026-08-05-c1-compute-reconcile-design.md`

## Global Constraints
- **c1.ts 用 detail-sources.json 驱动**（agg_metric/brand_expr/detail_date_expr/tolerance/report_type），不硬编码。
- **brand_expr 用 regexp_extract**（不 dim_branch JOIN，wholesale 64188 由 filename）。
- **自动重算 ≤3 次**（/compute DELETE-before-INSERT 幂等，重算后重跑 C1 验收敛）。
- **配置同步**：services/semantic-generator/src/detail-sources.json 改后字节同步 web/lib/qa/config/detail-sources.json。
- **保留 09:07 粗筛**（reconcile_table_consistency + reconcile_daily_results）。
- 复用 c0-runner/c0.ts 模式 + d1.ts 的 buildDayGlob/duckQuery。

## File Structure
| 文件 | 责任 | 动作 |
|---|---|---|
| `services/semantic-generator/src/detail-sources.json` | 加 report_type | 改 |
| `web/lib/qa/config/detail-sources.json` | 字节同步 | 改 |
| `web/lib/qa/c1.ts` | 对账核心逻辑 | 新建 |
| `web/lib/qa/c1-runner.ts` | 遍历+注入+自动重算 | 新建 |
| `web/lib/qa-runner.ts` | 注入 C1（L250 旁同 C0） | 改 |
| `web/app/api/admin/qa-run/route.ts` | 同步注入 | 改 |
| `web/lib/scheduler.ts` | executeTask 采集后追加 C1 | 改 |
| `web/lib/qa/__tests__/c1.test.ts` | c1.ts 单测 | 新建 |
| `scripts/reconcile-check.js` | 删 | 删 |
| `scripts/cron-reconcile.sh` | 删 | 删 |
| `web/app/api/admin/reconcile-check/route.ts` | 下线 | 删 |

---

### Task 1: detail-sources 加 report_type + c1.ts 对账逻辑 + 单测

**Files:**
- Modify: `services/semantic-generator/src/detail-sources.json`、`web/lib/qa/config/detail-sources.json`
- Create: `web/lib/qa/c1.ts`、`web/lib/qa/__tests__/c1.test.ts`
- Ref: `web/lib/qa/c0.ts`、`web/lib/qa/d1.ts`（buildDayGlob/duckQuery 模板）

**Interfaces:**
- Produces: `runC1(src, from, to, {duck, pg}) -> CheckResult`；`DetailSource.report_type` 字段

- [ ] **Step 1: detail-sources.json 加 report_type**

3 源各加 `"report_type"`：
- retail: `"report_type": "daily_sales"`
- delivery: `"report_type": "daily_delivery"`
- wholesale: `"report_type": "daily_wholesale"`

同步 web 副本（`diff` 确认无差异）。同步更新 `web/lib/qa/types.ts` 的 `DetailSource` 接口加 `report_type: string`。

- [ ] **Step 2: 写 c1.ts 失败测试**

Create `web/lib/qa/__tests__/c1.test.ts`（照 c0.test.ts/d1.test.ts 模式，mock duck + pg）：
```ts
import { describe, it, expect, vi } from 'vitest';
import { runC1 } from '../c1';

describe('runC1', () => {
  it('passes when detail==agg per sbc|bizday|metric', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{sbc:'3120',bizday:'20260804',detail_sum:100}]) };
    const pg = { query: vi.fn().mockResolvedValue([{sbc:'3120',bizday:'20260804',agg_sum:100}]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('pass');
  });
  it('fails with diff detail when mismatch', async () => {
    const duck = { query: vi.fn().mockResolvedValue([{sbc:'3120',bizday:'20260804',detail_sum:100}]) };
    const pg = { query: vi.fn().mockResolvedValue([{sbc:'3120',bizday:'20260804',agg_sum:99}]) };
    const r = await runC1(src, '2026-08-04', '2026-08-04', { duck, pg });
    expect(r.status).toBe('fail');
    expect(r.detail[0].diff).toBe(1);
  });
});
```
（src 是 mock DetailSource，含 agg_metric[{detail:'sale_money',agg:'total_sale'}] 等）

- [ ] **Step 3: 跑确认失败** - `cd web && npx vitest run lib/qa/__tests__/c1.test.ts` -> FAIL（c1.ts 不存在）

- [ ] **Step 4: 实现 c1.ts**

Create `web/lib/qa/c1.ts`（照 spec 段2，duck SQL + pg SQL + join + diff）：
```ts
import type { DetailSource } from './types';
import type { CheckResult } from './qa-types';

export interface C1Opts { duck: { query: (sql: string) => Promise<any[]> }; pg: { query: (sql: string, params?: any[]) => Promise<any[]> }; }

export async function runC1(src: DetailSource, fromIso: string, toIso: string, opts: C1Opts): Promise<CheckResult> {
  const fromCompact = fromIso.replace(/-/g, '');
  const toCompact = toIso.replace(/-/g, '');
  const mismatches: any[] = [];
  for (const m of src.agg_metric) {
    const duckSql = `SELECT ${src.brand_expr} AS sbc, ${src.detail_date_expr} AS bizday, SUM(CAST(${m.detail} AS DECIMAL(18,2))) AS detail_sum FROM read_parquet('${src.glob}') WHERE ${src.detail_date_expr} BETWEEN '${fromCompact}' AND '${toCompact}' GROUP BY sbc, bizday`;
    const pgSql = `SELECT system_book_code AS sbc, to_char(biz_date,'YYYYMMDD') AS bizday, SUM(${m.agg}) AS agg_sum FROM ${src.agg_table} WHERE biz_date BETWEEN '${fromIso}' AND '${toIso}' GROUP BY sbc, bizday`;
    const [duckRows, pgRows] = await Promise.all([opts.duck.query(duckSql), opts.pg.query(pgSql)]);
    const pgMap = new Map(pgRows.map((r: any) => [`${r.sbc}|${r.bizday}`, r.agg_sum]));
    for (const d of duckRows) {
      const agg = pgMap.get(`${d.sbc}|${d.bizday}`) ?? 0;
      const diff = Math.round((Number(d.detail_sum) - Number(agg)) * 100) / 100;
      if (Math.abs(diff) > src.tolerance) mismatches.push({ sbc: d.sbc, bizday: d.bizday, metric: m.agg, detail_sum: d.detail_sum, agg_sum: agg, diff });
    }
  }
  return { status: mismatches.length ? 'fail' : 'pass', detail: mismatches, check_type: 'C1', check_name: src.name };
}
```

- [ ] **Step 5: 跑确认通过** - vitest c1.test.ts PASS

- [ ] **Step 6: Commit**

```bash
git add services/semantic-generator/src/detail-sources.json web/lib/qa/config/detail-sources.json web/lib/qa/types.ts web/lib/qa/c1.ts web/lib/qa/__tests__/c1.test.ts
git commit -m "feat(qa): c1.ts 对账核心 + detail-sources 加 report_type (C1)"
```

---

### Task 2: c1-runner + 自动重算 retry + qa-runner 注入 + 单测

**Files:**
- Create: `web/lib/qa/c1-runner.ts`、`web/lib/qa/__tests__/c1-runner.test.ts`
- Modify: `web/lib/qa-runner.ts`（L250 旁注入，同 C0）、`web/app/api/admin/qa-run/route.ts`
- Ref: `web/lib/qa/c0-runner.ts`（模板）

**Interfaces:**
- Consumes: `runC1` from Task 1、`DetailSource.report_type`
- Produces: `runC1Checks(opts) -> CheckResult[]`（含自动重算 retry）

- [ ] **Step 1: 写 c1-runner 失败测试**（mock runC1 + /compute，验证 retry ≤3 + 收敛）

- [ ] **Step 2: 实现 c1-runner.ts**

照 c0-runner.ts 结构：遍历 detailSources，按 `checks` 过滤 `C1:<name>`，窗口 7 天，调 runC1；fail 时取 `src.report_type` + bizday -> POST /compute（≤3 retry，重跑 runC1 验收敛），写 qa_logs。

```ts
export async function runC1Checks(opts: { client, duck, runId, trigger, checks }): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const src of detailSources) {
    if (opts.checks && !opts.checks.some(c => c === 'C1' || c === `C1:${src.name}`)) continue;
    const [from, to] = getYesterdayWindow(7); // 昨天回溯7天
    let r = await runC1(src, from, to, { duck: opts.duck, pg: opts.client });
    let retries = 0;
    while (r.status === 'fail' && retries < 3 && r.detail.length) {
      // 取首个差异日重算
      const bizday = r.detail[0].bizday;
      const iso = `${bizday.slice(0,4)}-${bizday.slice(4,6)}-${bizday.slice(6,8)}`;
      await fetch(`${process.env.DUCKDB_URL}/compute`, { method:'POST', headers:{'x-agent-key':process.env.AGENT_API_KEY!}, body: JSON.stringify({ report_type: src.report_type, date_from: iso, date_to: iso }) });
      r = await runC1(src, iso, iso, { duck: opts.duck, pg: opts.client });
      retries++;
    }
    r.retries = retries;
    await writeQaLog(opts.client, { run_id: opts.runId, trigger: opts.trigger, check_type:'C1', check_name: src.name, status: r.status, diff: r.detail.length, detail: r.detail, run_at: new Date().toISOString() });
    results.push(r);
  }
  return results;
}
```

- [ ] **Step 3: qa-runner.ts 注入 C1**（L250 旁，同 C0 模式）

```ts
if (!checks || checks.some(c => c.startsWith('C1'))) {
  results.push(...await runC1Checks({ client, duck, runId, trigger, checks }));
}
```
qa-run/route.ts 同步追加（同 C0 注入点 2）。

- [ ] **Step 4: 跑测试 + typecheck** - `cd web && npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add web/lib/qa/c1-runner.ts web/lib/qa/__tests__/c1-runner.test.ts web/lib/qa-runner.ts web/app/api/admin/qa-run/route.ts
git commit -m "feat(qa): c1-runner 自动重算 retry≤3 + qa-runner 注入 C1"
```

---

### Task 3: scheduler executeTask 采集后追加 C1

**Files:**
- Modify: `web/lib/scheduler.ts:660`（executeTask 末尾 D1+D2 旁）

- [ ] **Step 1: executeTask 末尾追加 C1 受影响源当日**

scheduler.ts:660 附近（D1+D2 当日分区之后），加 C1 单源当日（非全 7 天）：
```ts
// C1 采集后即时对账（受影响源当日）+ 自动重算
await runC1Checks({ client, duck, runId: `${runId}-post`, trigger:'collect', checks: [`C1:${taskSourceName}`] });
```
（taskSourceName 从 task 映射到 detail-sources name；窗口用采集 dates 当日）

- [ ] **Step 2: typecheck + build** - `cd web && npx tsc --noEmit && npm run build`

- [ ] **Step 3: Commit**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(qa): 采集后即时跑 C1 受影响源当日 (C1)"
```

---

### Task 4: 删三套 + 下线 route

**Files:**
- Delete: `scripts/reconcile-check.js`、`scripts/cron-reconcile.sh`、`web/app/api/admin/reconcile-check/route.ts`
- Ref: `web/lib/qa/__tests__/config-sync.test.ts`（确认无引用 reconcile-check）

- [ ] **Step 1: 删 3 文件**

```bash
git rm scripts/reconcile-check.js scripts/cron-reconcile.sh web/app/api/admin/reconcile-check/route.ts
```
（若 web/app/api/admin/reconcile-check/ 目录空，删目录）

- [ ] **Step 2: grep 确认无残留引用**

```bash
grep -rn "reconcile-check\|cron-reconcile" web/ scripts/ services/ --include='*.ts' --include='*.js' --include='*.sh' | grep -v node_modules
```
Expected：无引用（或仅注释/文档，更新之）。

- [ ] **Step 3: 主机 crontab 删 09:10**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "crontab -l | grep -v cron-reconcile | crontab -"
```
（GHA 部署不管主机 cron，需 SSH 手动删 09:10 条目）

- [ ] **Step 4: typecheck + build + 全量测试** - `cd web && npx tsc --noEmit && npm run build && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(qa): 删 reconcile-check.js/cron-reconcile.sh/route，C1 收口 c1-runner (C1)"
```

---

### Task 5: GHA 部署 + 生产验证

**Files:** 无

- [ ] **Step 1: push main + GHA**

```bash
git push origin main
gh run watch <run-id>
```

- [ ] **Step 2: 部署后验证 C1 qa_logs + 自动重算**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT check_name, status, diff, run_at FROM qa_logs WHERE check_type='C1' ORDER BY run_at DESC LIMIT 5;\""
```
Expected：3 源 C1 记录，status=pass（或 fail+retries）。手动造差异（改某聚合表一行）-> 跑 `/api/admin/qa-run?check=C1` -> 确认自动重算收敛。

- [ ] **Step 3: 确认 09:07 粗筛仍在 + 09:10 已删**

```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT * FROM reconcile_daily_results ORDER BY checked_at DESC LIMIT 5;'"
ssh ... "crontab -l | grep cron-reconcile"  # 应无输出
```

---

## Self-Review

**Spec coverage：** 收口架构（Task 1 detail-sources + Task 4 删三套）✅；c1.ts 对账（Task 1）✅；自动重算 ≤3（Task 2）✅；qa-runner 注入（Task 2）✅；采集后 C1（Task 3）✅；部署验证（Task 5）✅。

**Placeholder scan：** c1.ts/c1-runner 给完整 code；detail-sources report_type 明确；自动重算 retry 逻辑完整。

**Type consistency：** `runC1(src,from,to,opts)->CheckResult` 跨 Task 1-2 一致；`DetailSource.report_type` Task 1 加、Task 2 用；`runC1Checks` Task 2-3 一致。

**风险点：** wholesale brand_expr 用 regexp_extract（不 dim_branch JOIN）--生产验证若 64188 口径有误再补；采集后 C1 性能（duck parquet 读）--只跑受影响源当日非全 7 天；主机 crontab 09:10 需 SSH 手动删（GHA 不管）。
