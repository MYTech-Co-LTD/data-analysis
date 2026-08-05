// web/lib/qa/c4-runner.ts
// C4 口径回归执行器：运行期调 validate_semantic_registry RPC（registry 静态校验，迁移 131）。
// 该 RPC 返回 TABLE(issue TEXT)，5 项静态校验：
//   1) base 指标 fact_table 已注册 datasets 或为 PG 表
//   2) derived 指标 depends_on 全部存在于 registry（闭环）
//   3) static 维度 join_key 存在于 join_table
//   4) static 维度层级 key_column 存在于 join_table
//   5) derived formula_ast 的 ref 节点：metric_code 在 registry 或窗口列集合
// 空 = pass，有 issue = fail（diff=issue 数，detail=issue 列表）。
// 目的：registry 配置闭环改动（改 metric_registry.formula_ast / dimensions / depends_on）后
//   运行期即可发现口径回归，不必等报表数据错。
//
// 注入点：qa-runner.ts runQaChecks 内（C3 模式，L130-132 旁）；route 与 scheduler 经 runQaChecks 自动覆盖。
// pg 适配：经 execute_sql RPC（006，SECURITY DEFINER 绕 RLS）执行 raw SQL——与 c3-runner 同款，
//   使 scripts/qa-run.ts CLI 的 execute_sql 分支与 PostgREST /rpc/execute_sql 双适配器都能跑。
import type { CheckResult, QaTrigger } from './types';

export const C4_CHECK_NAME = 'semantic-registry';

export interface C4RunnerOpts {
  db: {
    rpc(fn: string, body: Record<string, unknown>): Promise<{ data?: unknown[]; error?: unknown }>;
    from(t: string): { insert(rows: unknown[]): Promise<{ data?: unknown[]; error?: unknown }>; };
  };
  runId: string;
  trigger: QaTrigger;
  checks?: string[];
}

/** pg.query 适配器：经 execute_sql RPC 执行 raw SQL，返 issue 行（{issue}）。
 *  包装 to_jsonb 确保 SETOF JSONB 返回行对象（execute_sql 006 的 RETURN QUERY EXECUTE
 *  对多列行不自动转 JSONB，需显式 to_jsonb(q) 包装；PostgREST 可能返 [{to_jsonb:{...}}]
 *  或 [{...}]，统一提取）。 */
async function pgQuery(db: C4RunnerOpts['db']): Promise<{ issue: string }[]> {
  const wrapped = `SELECT to_jsonb(q) FROM (SELECT * FROM validate_semantic_registry()) AS q`;
  const { data, error } = await db.rpc('execute_sql', { query: wrapped });
  if (error) throw new Error('C4 validate_semantic_registry failed: ' + JSON.stringify(error));
  const rows = (data ?? []) as any[];
  return rows.map((row: any) => (row && typeof row === 'object' && 'to_jsonb' in row ? row.to_jsonb : row));
}

export async function runC4Checks(opts: C4RunnerOpts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { db, runId, trigger, checks } = opts;

  // 定向过滤：C4（全部）或 C4:semantic-registry（唯一检查名）
  if (checks && !checks.some((c) => c === 'C4' || c === `C4:${C4_CHECK_NAME}`)) return results;

  try {
    const issues = await pgQuery(db);
    const result: CheckResult = {
      run_id: runId,
      trigger,
      check_type: 'C4',
      check_name: C4_CHECK_NAME,
      status: issues.length ? 'fail' : 'pass',
      diff: issues.length,
      detail: issues.length ? issues : null,
    };
    results.push(result);
    const ins = await db.from('qa_logs').insert([result]);
    if (ins.error) console.error('[c4-runner] qa_logs insert failed:', ins.error);
  } catch (e) {
    const errResult: CheckResult = {
      run_id: runId,
      trigger,
      check_type: 'C4',
      check_name: C4_CHECK_NAME,
      status: 'error',
      diff: null,
      detail: [{ error: String(e instanceof Error ? e.message : e) }],
    };
    results.push(errResult);
    const ins = await db.from('qa_logs').insert([errResult]);
    if (ins.error) console.error('[c4-runner] qa_logs insert failed:', ins.error);
  }

  return results;
}
