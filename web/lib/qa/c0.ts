// web/lib/qa/c0.ts
// C0 源API count ↔ 明细 parquet count（按日×品牌，双向）
// 分毫不差语义：库计数必须 == 源计数，任一差异 → fail（库<源=缺漏，库>源=疑重）。
// 旧的 ε=0.1 容差会放过 10% 以内的缺漏/重复——用户要求采集与源分毫不差，改精确匹配。
import type { DetailSource, CheckResult } from './types';

export const C0_EPSILON = 0;   // 0 = 精确匹配（分毫不差）

export async function runC0(
  src: DetailSource,
  day: string,
  apiCount: number,        // 源 API 返回的总数；<0 = 源取数失败
  libCount: number,        // 库内 parquet 行数
): Promise<CheckResult> {
  let status: CheckResult['status'] = apiCount < 0 ? 'error' : 'pass';
  let diff: number | null = null;
  let detail: unknown[] | null = null;
  if (apiCount >= 0) {
    if (libCount !== apiCount) {
      status = 'fail';
      const verdict = libCount < apiCount ? 'missing' : 'dup-suspect';
      detail = [{ day, api: apiCount, lib: libCount, verdict }];
      diff = libCount - apiCount;
    } else {
      diff = 0;
    }
  } else {
    detail = [{ day, api: apiCount, lib: libCount, verdict: 'error' }];
  }
  return { run_id: '', trigger: 'manual', check_type: 'C0', check_name: src.name, status, diff, detail };
}
