// web/lib/qa/c0.ts
// C0 源API count ↔ 明细 parquet count（按日×品牌，双向）
// 库<源×(1-ε) = 缺漏；库>源×(1+ε) = 疑重（补上单向周对账抓不到重复的盲区）
import type { DetailSource, CheckResult } from './types';

export const C0_EPSILON = 0.1;

export type ApiCountFn = (authToken: string, ...args: any[]) => Promise<number>;

export interface C0Row {
  source: string;
  day: string;
  api: number;
  lib: number;
  verdict: 'ok' | 'missing' | 'dup-suspect' | 'error';
}

export async function runC0(
  src: DetailSource,
  day: string,
  apiCount: number,        // 调用方已按源取数
  libCount: number,
): Promise<CheckResult> {
  let status: CheckResult['status'] = apiCount < 0 ? 'error' : 'pass';
  let diff: number | null = null;
  let detail: unknown[] | null = null;
  if (apiCount >= 0) {
    // 零量缺漏守卫：apiCount=1 时 low=floor(0.9)=0，lib=0 会漏过 low 判定滑成 pass；
    // 完全未采集 = C0 首要要抓的场景，须在 ε 带比较前显式判 fail。
    if (libCount === 0 && apiCount > 0) { status = 'fail'; detail = [{ day, api: apiCount, lib: libCount, verdict: 'missing' }]; diff = libCount - apiCount; }
    else {
      const low = Math.floor(apiCount * (1 - C0_EPSILON));
      const high = Math.ceil(apiCount * (1 + C0_EPSILON));
      if (libCount < low) { status = 'fail'; detail = [{ day, api: apiCount, lib: libCount, verdict: 'missing' }]; diff = libCount - apiCount; }
      else if (libCount > high) { status = 'fail'; detail = [{ day, api: apiCount, lib: libCount, verdict: 'dup-suspect' }]; diff = libCount - apiCount; }
      else { diff = libCount - apiCount; }
    }
  } else {
    detail = [{ day, api: apiCount, lib: libCount, verdict: 'error' }];
  }
  return { run_id: '', trigger: 'manual', check_type: 'C0', check_name: src.name, status, diff, detail };
}
