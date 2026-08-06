// web/lib/qa/alert.ts
// QA 告警分组：fail/error（真异常：采集/网络/权限）与 no-data（数据未到：源无数据/parquet 未创建）分开，
// no-data 不混入 fail/error 告警，走独立「数据未到」企微告警。qa-run/route 与 scheduler 共用，逻辑单点可测。
import type { CheckResult } from './types';

export function partitionQaResults(results: CheckResult[]): {
  failed: CheckResult[];
  noData: CheckResult[];
} {
  return {
    failed: results.filter((r) => r.status === 'fail' || r.status === 'error'),
    noData: results.filter((r) => r.status === 'no-data'),
  };
}
