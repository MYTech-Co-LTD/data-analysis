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
  /** 当天粗粒度健康检查：lib 跟随 api（≥50%）即 pass，仅大偏差（结构性损坏）才 fail，且不触发 autoBackfill。
   *  当天源在持续增长，ε=0 精确匹配必误报（采集后窗口竞态）；精确对账交给次日完结日 C0。 */
  coarse?: boolean;
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
  } else if (flags?.coarse) {
    // 当天粗粒度健康检查：lib 跟随 api（≥ 50%）即视为健康；仅大偏差（结构性损坏，
    // 如采集整日 0 行而源在涨）才 fail。小偏差是当天流式数据的正常竞态，不算漏采。
    // 但 lib > api（parquet 行数超过源）一定异常——增量只追加不删除，
    // 正常 parquet ≤ lemeng count（还没追完）；parquet > count 说明 /merge 累积了
    // lemeng 已删除的行（退款重开/冲正致 key 变化），精确告警不误报（实测坑 2026-08-08：+30 行/2967元）。
    if (apiN > 0 && libN < apiN * 0.5) {
      status = 'fail';
      detail = [{ day, api: apiN, lib: libN, verdict: 'gross-missing' }];
      diff = libN - apiN;
    } else if (libN > apiN && apiN > 0) {
      status = 'fail';
      detail = [{ day, api: apiN, lib: libN, verdict: 'merge-accumulation' }];
      diff = libN - apiN;
    } else {
      diff = 0;
    }
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
