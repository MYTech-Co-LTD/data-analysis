// web/lib/collect-backfill.ts
// 按日期补采共享逻辑：collect-backfill route（手动）与 scheduler / C0 autoBackfill（自动）共用。
// full 模式重采指定 [date_from, date_to] 范围，覆盖写 parquet（修复漏采/补历史缺口）。
import { collectOnce } from './collect';
import { collectDeliveryOnce } from './collect-delivery';
import { collectWholesaleOnce } from './collect-wholesale';

/** 补采所需的最小任务视图（route 的 collect_tasks 行 / c0-runner 的 select('source_id,params') 行都满足） */
export interface BackfillTask {
  source_id: string;
  params: any;
  function_slug?: string;
}

/** full 模式补采：retail collectOnce / delivery collectDeliveryOnce / wholesale collectWholesaleOnce。
 *  按 task.params.task_type 分派，与 collect-backfill route 原逻辑一致。 */
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
  if (tt === 'delivery') {
    const dist = Number(params.distribution_branch_num) || 99;
    return collectDeliveryOnce(authToken, dist, String(dist), `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
  }
  if (tt === 'wholesale') {
    const bn = (params.branch_nums || []).join(',');
    return collectWholesaleOnce(authToken, bn, `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
  }
  // retail（默认）：dates=[from,to]
  const branchNums = (params.branch_nums || []) as number[];
  return collectOnce(authToken, branchNums, branchNums.join(','), [date_from, date_to], limit, { mode: 'full' });
}
