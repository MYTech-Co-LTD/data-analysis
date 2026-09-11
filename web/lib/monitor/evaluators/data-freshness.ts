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
  const t = (rule.threshold ?? {}) as Record<string, unknown>;
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
    )) as unknown as Array<{ d: string }>;
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
