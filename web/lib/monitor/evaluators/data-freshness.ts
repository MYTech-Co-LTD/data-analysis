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
    // 静默空转的坑：engine 会丢弃非 firing/非 recovery 的 context，配置少个冒号 = 规则永远
    // 无声无息地什么都不做。留痕（返回值不变）。
    console.warn(`[monitor] data_freshness target 解析失败（期望 '<dataset>:<账套>'）：${target || '(空)'}`);
    return { firing: false, alert_key: alertKey, context: { reason: 'bad_target' } };
  }
  // 单真相源：真正探测的是 threshold.glob_template，而 context 里的 dataset 来自 target。
  // 两者不符 = 配置写串了（也顺带拦住 'a:b:c' 被 split 静默截断成 a/b 的情形）。
  if (t.dataset !== undefined && String(t.dataset) !== dataset) {
    console.warn(
      `[monitor] data_freshness 配置不一致：target 的 dataset='${dataset}' 与 threshold.dataset='${String(t.dataset)}' 不符（${target}）`,
    );
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
    const msg = String((e as Error)?.message ?? e);
    // 「glob 一个文件都没匹配到」不是探测故障，而是**该分区确实不存在**——正是本守护要报的情形。
    // DuckDB 对此抛异常（不是返回空集），若不特判就会在唯一必须响的场景里静默。
    // 与既有约定一致（web/lib/qa/c0-runner.ts、c1-runner.ts、item-master.ts 同样把该串当「数据未到」）。
    if (msg.includes('No files found')) {
      console.warn(`[monitor] data_freshness 无匹配文件（视为分区缺失）${target}:`, msg);
      return {
        firing: true,
        alert_key: alertKey,
        context: {
          dataset,
          account,
          expect_date: expectDate,
          have_latest: 'none',
          // ★ 同下方正常分支：模板里的 `🔴 [{severity}]` 需要 context 提供 severity 才会被替换。
          severity: rule.severity,
        },
      };
    }
    console.error(`[monitor] data_freshness 探测异常 ${target}:`, msg);
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
