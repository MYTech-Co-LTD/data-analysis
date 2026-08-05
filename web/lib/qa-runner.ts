// web/lib/qa-runner.ts
// 语义层数据质量守护 QA 运行器（L4）：编排 D1/D2/C2/C5/C1 检查，写 qa_logs。
// 依赖注入 db(postgrest)/duck(duckdb HTTP)，web route 与 scheduler 共用。
import { runD1 } from './qa/d1';
import { runD2 } from './qa/d2';
import { runItemMasterCheck } from './qa/item-master';
import { runBranchWarzoneCheck } from './qa/branch-warzone';
import { runC1Checks } from './qa/c1-runner';
import { runC3Checks } from './qa/c3-runner';
import detailSources from './qa/config/detail-sources.json';
import qaChecks from './qa/config/qa-checks.json';
import type { DetailSource, ViewAssertion, CheckResult, CheckType, QaTrigger } from './qa/types';

const DUCK_TOLERANCE = 0.01;

function compactDaysAgo(days: number): string {
  // 按平台中国时区口径（getDateOffsetChina 同款：UTC+8 后取日），
  // 使 runner 默认窗口与采集/after-collect 的 China-date 约定对齐（UTC 会偏一天边界）。
  const china = new Date(Date.now() + 8 * 60 * 60 * 1000);
  china.setDate(china.getDate() - days);
  return china.toISOString().slice(0, 10).replace(/-/g, '');
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
  /** 按源名覆盖 D1 glob（采集后日窗口用：只扫当日分区，避免全库重扫）；不传则用 src.glob 全量 */
  d1Globs?: Record<string, string>;
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
    try {
      const ins = await opts.db.from('qa_logs').insert([row]);
      if (ins.error) console.error('[qa-runner] qa_logs 写入失败:', JSON.stringify(ins.error));
    } catch (e) {
      console.error('[qa-runner] qa_logs 写入异常:', String(e instanceof Error ? e.message : e));
    }
  };

  // D1 明细主键唯一性
  for (const src of detailSources as DetailSource[]) {
    // D1 只对原始三源：item 源 natural_key=[]（item_num 在 retail_detail 非唯一）不适用，跳过。
    if (src.name !== 'retail' && src.name !== 'delivery' && src.name !== 'wholesale') continue;
    if (!want(opts.checks, 'D1', src.name)) continue;
    try {
      const { dupRows } = await runD1(opts.duck, src, dateFrom, dateTo, opts.d1Globs?.[src.name]);
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
      if (res.error) {
        await record('C2', a.view, 'error', null, [{ error: String(res.error) }]);
        continue;
      }
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

  // C5 商品主数据完整性：发现 delivery/wholesale 里不在 dim_item 的商品 → 自动触发商品采集 + 重算
  results.push(...await runItemMasterCheck({ db: opts.db, duck: opts.duck, runId: opts.runId, trigger: opts.trigger, checks: opts.checks }));

  // C5 门店战区完整性：近 N 天有销售但被排除出考核战区的门店（first_level_region 空/非考核）→ fail 告警
  results.push(...await runBranchWarzoneCheck({ db: opts.db, runId: opts.runId, trigger: opts.trigger, checks: opts.checks }));

  // C1 明细↔聚合对账 + 自动 /compute 重算 retry（fail -> 重算首个差异日 -> 单日重验，≤3 retry）
  if (!opts.checks || opts.checks.some(c => c.startsWith('C1'))) {
    results.push(...await runC1Checks({ db: opts.db, duck: opts.duck, runId: opts.runId, trigger: opts.trigger, checks: opts.checks }));
  }

  // C3 视图内部 rollup 自洽（战区和=小区和=门店和）：对层级视图 level 列动态 pivot，
  // 恢复 155 删 _audit 后的 rollup 自洽守护（不改生成器/视图，C2 模式注入）。
  if (!opts.checks || opts.checks.some(c => c.startsWith('C3'))) {
    results.push(...await runC3Checks({ db: opts.db, runId: opts.runId, trigger: opts.trigger, checks: opts.checks }));
  }

  return results;
}

export const qaDuckTolerance = DUCK_TOLERANCE;
