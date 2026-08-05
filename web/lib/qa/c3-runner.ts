// web/lib/qa/c3-runner.ts
// C3 视图内部 rollup 自洽执行器（方案 a：qa-runner 动态 pivot，不改生成器/视图）。
// 对层级视图按 level 列 pivot：SUM(level='region') vs SUM(level='sub_region') vs SUM(level='store')，
// |diff|>C3_TOLERANCE 记 mismatch（战区和=小区和=门店和）。校验指标：
//   report_region_breakdown_gen:       sale_actual / delivery_actual
//   report_supply_chain_outbound_gen:  delivery_amount
// 背景：旧 _audit 视图（report_*_v_audit，迁移 081/090/091 建的 drill 视图附属）被迁移 155 删除，
//   生成视图 report_*_gen 无 _audit。C3 用动态 pivot 恢复「rollup 自洽」守护，不重建 _audit。
//
// 注入点：qa-runner.ts runQaChecks 内（C2 旁，L94-112 后）；route 与 scheduler 经 runQaChecks 自动覆盖。
// pg 适配：经 execute_sql RPC（006，SECURITY DEFINER 绕 RLS）执行 raw SQL——与 c1-runner 同款。
// 校验口径：level 列字面量 'region'/'sub_region'/'store'（生成视图定义即契约，见 report_*_gen.sql）。
import type { CheckResult, QaTrigger } from './types';

export const C3_TOLERANCE = 0.01;

/** C3 校验的层级视图 + 指标（level 列字面量 'region'/'sub_region'/'store'） */
export interface C3ViewConfig {
  view: string;
  metrics: string[];
}

export const C3_ROLLUP_VIEWS: C3ViewConfig[] = [
  { view: 'report_region_breakdown_gen', metrics: ['sale_actual', 'delivery_actual'] },
  { view: 'report_supply_chain_outbound_gen', metrics: ['delivery_amount'] },
];

/** 构建 rollup pivot SQL。
 *  onlyMismatches=true（C3 用）→ 只返 |diff|>容差 的 target_id 行（每行=一个 mismatch）；
 *  false（health 面板用）→ 返全部 target_id 行，调用方自行算 max diff / totals。
 *  2026-08-05 修：PG HAVING 不能引用 SELECT 别名（region_total 等），原 HAVING 写法对真实库必报
 *  `column "region_total" does not exist`（单测 mock rpc 未抓到）——改外包一层子查询再 WHERE 过滤。 */
export function buildRollupPivotSql(view: string, metric: string, onlyMismatches = true): string {
  const base = `SELECT target_id,
    SUM(CASE WHEN level='region' THEN ${metric} END) AS region_total,
    SUM(CASE WHEN level='sub_region' THEN ${metric} END) AS sub_region_total,
    SUM(CASE WHEN level='store' THEN ${metric} END) AS store_total
  FROM ${view}
  GROUP BY target_id`;
  return onlyMismatches
    ? `SELECT * FROM (${base}) t WHERE ABS(region_total - sub_region_total) > ${C3_TOLERANCE} OR ABS(region_total - store_total) > ${C3_TOLERANCE}`
    : base;
}

export interface C3Mismatch {
  view: string;
  metric: string;
  target_id: number | string;
  region_total: number;
  sub_region_total: number;
  store_total: number;
  region_vs_sub_region_diff: number;
  region_vs_store_diff: number;
  diff: number; // max(|region-sub|, |region-store|)，round 2 位
}

export interface C3RunnerOpts {
  db: {
    rpc(fn: string, body: Record<string, unknown>): Promise<{ data?: unknown[]; error?: unknown }>;
    from(t: string): { insert(rows: unknown[]): Promise<{ data?: unknown[]; error?: unknown }>; };
  };
  runId: string;
  trigger: QaTrigger;
  checks?: string[];
}

/** pg.query 适配器：经 execute_sql RPC 执行 raw SQL，返 any[]（每行=对象）。
 *  包装 to_jsonb 确保 SETOF JSONB 返回行对象（同 c1-runner pgQuery，PostgREST 可能返
 *  [{to_jsonb:{...}}] 或 [{...}]，统一提取）。 */
async function pgQuery(db: C3RunnerOpts['db'], sql: string): Promise<any[]> {
  const wrapped = `SELECT to_jsonb(q) FROM (${sql}) AS q`;
  const { data, error } = await db.rpc('execute_sql', { query: wrapped });
  if (error) throw new Error('C3 pg query failed: ' + JSON.stringify(error));
  const rows = (data ?? []) as any[];
  return rows.map((row: any) => (row && typeof row === 'object' && 'to_jsonb' in row ? row.to_jsonb : row));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function runC3Checks(opts: C3RunnerOpts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { db, runId, trigger, checks } = opts;

  for (const cfg of C3_ROLLUP_VIEWS) {
    // 定向过滤：C3（全部）或 C3:<view>（单视图）
    if (checks && !checks.some((c) => c === 'C3' || c === `C3:${cfg.view}`)) continue;
    try {
      const mismatches: C3Mismatch[] = [];
      for (const metric of cfg.metrics) {
        const rows = await pgQuery(db, buildRollupPivotSql(cfg.view, metric, true));
        for (const r of rows) {
          const region = num(r.region_total);
          const sub = num(r.sub_region_total);
          const store = num(r.store_total);
          mismatches.push({
            view: cfg.view,
            metric,
            target_id: r.target_id,
            region_total: region,
            sub_region_total: sub,
            store_total: store,
            region_vs_sub_region_diff: Math.round(Math.abs(region - sub) * 100) / 100,
            region_vs_store_diff: Math.round(Math.abs(region - store) * 100) / 100,
            diff: Math.round(Math.max(Math.abs(region - sub), Math.abs(region - store)) * 100) / 100,
          });
        }
      }
      const result: CheckResult = {
        run_id: runId,
        trigger,
        check_type: 'C3',
        check_name: cfg.view,
        status: mismatches.length ? 'fail' : 'pass',
        diff: mismatches.length ? mismatches[0].diff : 0,
        detail: mismatches.length ? mismatches : null,
      };
      results.push(result);
      const ins = await db.from('qa_logs').insert([result]);
      if (ins.error) console.error('[c3-runner] qa_logs insert failed:', ins.error);
    } catch (e) {
      const errResult: CheckResult = {
        run_id: runId,
        trigger,
        check_type: 'C3',
        check_name: cfg.view,
        status: 'error',
        diff: null,
        detail: [{ error: String(e instanceof Error ? e.message : e) }],
      };
      results.push(errResult);
      const ins = await db.from('qa_logs').insert([errResult]);
      if (ins.error) console.error('[c3-runner] qa_logs insert failed:', ins.error);
    }
  }

  return results;
}
