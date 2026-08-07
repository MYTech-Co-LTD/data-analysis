// web/lib/collect-backfill.ts
// 按日期补采共享逻辑：collect-backfill route（手动）与 scheduler / C0 autoBackfill（自动）共用。
// full 模式重采指定 [date_from, date_to] 范围，覆盖写 parquet（修复漏采/补历史缺口）。
import { collectOnce } from './collect';
import { collectDeliveryOnce } from './collect-delivery';
import { collectWholesaleOnce } from './collect-wholesale';

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY;

/** 补采所需的最小任务视图（route 的 collect_tasks 行 / c0-runner 的 select('source_id,params') 行都满足） */
export interface BackfillTask {
  source_id: string;
  params: any;
  function_slug?: string;
}

function subtractDays(ymd: string, days: number): string {
  const dt = new Date(ymd + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/** 补采落盘成功后触发报表重算：补采只写 parquet 不算报表 → 报表滞留旧值
 *  （2026-08-07 实锤：backfill 08-06 后报表仍 312976.90 vs parquet 318285.70，差 5,308 元 = 125 条晚到单未进报表）。
 *  触发与 scheduler triggerCompute 相同的 8 类报表（幂等，多算无害）。失败仅记日志不阻断补采（补采是主任务）。 */
async function triggerComputeForRange(dateFrom: string, dateTo: string): Promise<void> {
  const reports = [
    { type: 'daily_sales', dateFrom, dateTo },
    { type: 'daily_category', dateFrom, dateTo },
    { type: 'weekly_trend', dateFrom: subtractDays(dateFrom, 56), dateTo },
    { type: 'daily_delivery', dateFrom, dateTo },
    { type: 'daily_wholesale', dateFrom, dateTo },
    { type: 'item_sales', dateFrom, dateTo },
    { type: 'item_outbound', dateFrom, dateTo },
    { type: 'wholesale_customer', dateFrom, dateTo },
  ];
  for (const r of reports) {
    try {
      const resp = await fetch(`${DUCKDB_URL}/compute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY! },
        body: JSON.stringify({ report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo }),
      });
      if (!resp.ok) console.error(`[collect-backfill] /compute ${r.type} ${r.dateFrom}~${r.dateTo} HTTP ${resp.status}`);
    } catch (e: any) {
      console.error(`[collect-backfill] /compute ${r.type} 异常:`, e?.message ?? e);
    }
  }
}

/** full 模式补采：retail collectOnce / delivery collectDeliveryOnce / wholesale collectWholesaleOnce。
 *  按 task.params.task_type 分派，与 collect-backfill route 原逻辑一致。
 *  补采落盘成功后同步触发该日期范围报表重算（P0：消除补采后报表滞留旧值）。 */
export async function runCollectBackfill(
  task: BackfillTask,
  authToken: string,
  date_from: string,
  date_to: string,
): Promise<{
  records: any[];
  apiTotal: number;
  storagePath: string;
  error: string;
  newApiTotal: number;
  skipped: boolean;
}> {
  const params = task.params || {};
  const limit = params.page_size || 200;
  const tt = params.task_type;
  let result: any;
  if (tt === 'delivery') {
    const dist = Number(params.distribution_branch_num) || 99;
    result = await collectDeliveryOnce(authToken, dist, String(dist), `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
  } else if (tt === 'wholesale') {
    const bn = (params.branch_nums || []).join(',');
    result = await collectWholesaleOnce(authToken, bn, `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
  } else {
    // retail（默认）：dates=[from,to]
    const branchNums = (params.branch_nums || []) as number[];
    result = await collectOnce(authToken, branchNums, branchNums.join(','), [date_from, date_to], limit, { mode: 'full' });
  }
  // 补采落盘成功后触发报表重算（同步等待，保证调用方回来后报表已更新；失败仅记日志）
  if (!result.error && Number(result.records?.length || 0) > 0) {
    await triggerComputeForRange(date_from, date_to).catch((e: any) => console.error('[collect-backfill] 触发报表重算失败:', e?.message ?? e));
  }
  return result;
}
