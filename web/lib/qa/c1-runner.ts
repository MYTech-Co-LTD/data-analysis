// web/lib/qa/c1-runner.ts
// C1 明细↔聚合对账执行器 + 自动 /compute 重算 retry（≤3）。
// 遍历 detailSources，7 天窗口调 runC1；fail 时取首个差异 bizday -> POST /compute 重算
// -> 重跑 runC1（单日）验收敛。retry 上限 3，仍 fail 放弃告警。
// qa-runner 调用（同 C5 模式：内联 runQaChecks），route 与 scheduler 经 runQaChecks 自动覆盖。
//
// 设计决策：
// - 注入点选 qa-runner.ts runQaChecks 内（C5 模式）而非 route/scheduler 外挂（C0 模式），
//   因为 C1 只需 db 适配器（rpc+from）与 duck 函数，runQaChecks 已具备，无需额外传 client。
// - pg.query 适配器：经 execute_sql RPC（006，SECURITY DEFINER 绕 RLS）执行 raw SQL，
//   包装 SELECT to_jsonb(q) FROM (...) AS q 确保 SETOF JSONB 返回正确对象。
//   不用 execute_sql_rls（040）因其禁查 report_daily_sales 基表（C1 需查基表非 _v 视图，
//   _v 有 RLS/can_see_cost 脱敏，与 duck 端 raw SUM 不可比）。
import { runC1 } from './c1';
import { buildDayGlob } from './d1';
import detailSources from './config/detail-sources.json';
import type { DetailSource, CheckResult, QaTrigger } from './types';
import { getDateOffsetChina, fetchWithTimeout, REQUEST_TIMEOUT } from '../collect';

const C1_DAYS = 7;      // 昨天回溯 7 天窗口
const MAX_RETRIES = 3;   // /compute 重算上限

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';

export interface C1RunnerOpts {
  db: {
    rpc(fn: string, body: Record<string, unknown>): Promise<{ data?: unknown[]; error?: unknown }>;
    from(t: string): { insert(rows: unknown[]): Promise<{ data?: unknown[]; error?: unknown }>; };
  };
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  runId: string;
  trigger: QaTrigger;
  checks?: string[];
  /** 窗口覆盖（ISO YYYY-MM-DD）。不传则默认 7 天回溯（昨天往前 C1_DAYS 天）。
   *  采集后即时对账传当日单日窗口（性能优化，避免每 5 分钟全 7 天扫描）。 */
  window?: { from: string; to: string };
}

/** pg.query 适配器：经 execute_sql RPC 执行 raw SQL，返 any[]（每行=对象）。
 *  包装 to_jsonb 确保 SETOF JSONB 返回行对象（execute_sql 006 的 RETURN QUERY EXECUTE
 *  对多列行不自动转 JSONB，需显式 to_jsonb(q) 包装）。 */
async function pgQuery(db: C1RunnerOpts['db'], sql: string): Promise<any[]> {
  const wrapped = `SELECT to_jsonb(q) FROM (${sql}) AS q`;
  const { data, error } = await db.rpc('execute_sql', { query: wrapped });
  if (error) throw new Error('pg query failed: ' + JSON.stringify(error));
  const rows = (data ?? []) as any[];
  // PostgREST SETOF JSONB 可能返 [{to_jsonb: {...}}] 或 [{...}]，统一提取
  return rows.map((row: any) => (row && typeof row === 'object' && 'to_jsonb' in row ? row.to_jsonb : row));
}

/** POST /compute 重算指定 report_type + 日期。
 *  失败仅记日志不 throw（retry 后 runC1 仍 fail -> 最终告警，不因 /compute 本身崩阻断流程）。
 *  30s 超时（fetchWithTimeout）：采集后 QA（executeTask 内）/compute 挂起 → 超时抛错被 catch，不永久持锁。 */
async function recompute(report_type: string, dateIso: string): Promise<void> {
  try {
    const r = await fetchWithTimeout(`${DUCKDB_URL}/compute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
      body: JSON.stringify({ report_type, date_from: dateIso, date_to: dateIso }),
    }, REQUEST_TIMEOUT);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      console.error(`[c1-runner] recompute ${report_type} ${dateIso} failed: ${r.status} ${JSON.stringify(j)}`);
    }
  } catch (e) {
    console.error(`[c1-runner] recompute ${report_type} ${dateIso} error:`, e);
  }
}

export async function runC1Checks(opts: C1RunnerOpts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { db, duck, runId, trigger, checks, window: win } = opts;

  const duckAdapter = { query: duck };
  const pgAdapter = { query: (sql: string) => pgQuery(db, sql) };

  // 窗口：opts.window 优先（采集后当日单日），否则默认 7 天回溯
  const fromIso = win?.from ?? getDateOffsetChina(-C1_DAYS);
  const toIso = win?.to ?? getDateOffsetChina(-1);

  for (const src of detailSources as DetailSource[]) {
    // 过滤：C1（全部）或 C1:<name>（定向）
    if (checks && !checks.some(c => c === 'C1' || c === `C1:${src.name}`)) continue;

    // M19: window 传入（采集后单日）时用 buildDayGlob 把 glob 缩到当日分区，
    // 避免每 5 分钟采集后全量历史 parquet 扫描（duckdb 谓词下推无法修剪计算表达式日期过滤）。
    // 7 天 job（无 window）保持原 glob 全扫（不频繁，OK）。
    const srcForDay = (dayIso: string): DetailSource =>
      win ? { ...src, glob: buildDayGlob(src, dayIso.replace(/-/g, '')) } : src;

    try {
      // 初始窗口对账（默认 7 天，或 opts.window 指定的单日）
      let r = await runC1(srcForDay(fromIso), fromIso, toIso, { duck: duckAdapter, pg: pgAdapter });
      let retries = 0;

      // 自动重算 retry：fail -> /compute 首个差异日 -> 单日重验
      while (r.status === 'fail' && retries < MAX_RETRIES && r.detail && (r.detail as any[]).length) {
        const mismatches = r.detail as any[];
        const firstMismatch = mismatches[0];
        const bizday: string = firstMismatch.bizday;       // YYYYMMDD 紧凑格式
        if (!bizday || bizday.length !== 8) break;           // 格式异常防死循环
        const iso = `${bizday.slice(0, 4)}-${bizday.slice(4, 6)}-${bizday.slice(6, 8)}`;

        await recompute(src.report_type, iso);
        r = await runC1(srcForDay(iso), iso, iso, { duck: duckAdapter, pg: pgAdapter });
        retries++;
      }

      const result: CheckResult = {
        ...r,
        run_id: runId,
        trigger,
      };
      results.push(result);

      const ins = await db.from('qa_logs').insert([result]);
      if (ins.error) console.error('[c1-runner] qa_logs insert failed:', ins.error);
    } catch (e) {
      const errResult: CheckResult = {
        run_id: runId,
        trigger,
        check_type: 'C1',
        check_name: src.name,
        status: 'error',
        diff: null,
        detail: [{ error: String(e instanceof Error ? e.message : e) }],
      };
      results.push(errResult);
      const ins = await db.from('qa_logs').insert([errResult]);
      if (ins.error) console.error('[c1-runner] qa_logs insert failed:', ins.error);
    }
  }

  return results;
}
