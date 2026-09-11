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
  const t = (rule.threshold ?? {}) as Record<string, unknown>;
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
    )) as unknown as Array<{ d: string; n: number }>;
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
