// web/lib/qa/c0.ts
// C0 源API count ↔ 明细 parquet count（按日×品牌，双向）
// 分毫不差语义：库计数必须 == 源计数，任一差异 → fail（库<源=缺漏，库>源=疑重）。
// 旧的 ε=0.1 容差会放过 10% 以内的缺漏/重复——用户要求采集与源分毫不差，改精确匹配。
// no-data：源 API 成功但 parquet 未创建（数据未到，非漏采/非异常）→ status='no-data'，独立预警不混 fail/error。
import type { DetailSource, CheckResult } from './types';

export const C0_EPSILON = 0;   // 0 = 精确匹配（分毫不差）

export interface C0Flags {
  /** 源 API count 调用失败（网络/鉴权/超时）→ 真 error */
  apiFailed?: boolean;
  /** parquet 缺失（duck 抛 No files found）→ 数据未到 no-data */
  libMissing?: boolean;
}

export async function runC0(
  src: DetailSource,
  day: string,
  apiCount: number | string,   // 源 API 返回的总数（lemeng 返回字符串，须强转）；<0 = 源取数失败
  libCount: number | string,   // 库内 parquet 行数
  flags?: C0Flags,
): Promise<CheckResult> {
  const apiN = Number(apiCount);
  const libN = Number(libCount);
  let status: CheckResult['status'] = 'pass';
  let diff: number | null = null;
  let detail: unknown[] | null = null;
  if (flags?.apiFailed || apiN < 0) {
    // 源取数失败（调用 throw 或 api<0）→ error，无法判定（网络/权限等真实异常）
    status = 'error';
    detail = [{ day, api: apiN, lib: libN, verdict: 'error' }];
  } else if (flags?.libMissing) {
    // 源 API 成功返回 0（当日源无数据）但 parquet 未创建 → 数据未到，独立 no-data（不触发补采/不混 fail 告警）
    status = 'no-data';
    detail = [{ day, api: apiN, lib: libN, verdict: 'no-data', reason: 'parquet not found' }];
  } else if (libN !== apiN) {
    status = 'fail';
    const verdict = libN < apiN ? 'missing' : 'dup-suspect';
    detail = [{ day, api: apiN, lib: libN, verdict }];
    diff = libN - apiN;
  } else {
    diff = 0;
  }
  return { run_id: '', trigger: 'manual', check_type: 'C0', check_name: src.name, status, diff, detail };
}
