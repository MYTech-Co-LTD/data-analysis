// web/lib/qa/__tests__/alert.test.ts
// 告警分组：fail/error（真异常）与 no-data（数据未到）分开，no-data 不混入 fail/error 告警。
import { describe, it, expect } from 'vitest';
import { partitionQaResults } from '../alert';
import type { CheckResult } from '../types';

const base: CheckResult = { run_id: 'r', trigger: 'manual', check_type: 'D1', check_name: 'retail', status: 'pass', diff: null, detail: null };

function mk(status: CheckResult['status']): CheckResult {
  return { ...base, status };
}

describe('partitionQaResults', () => {
  it('no-data 不混入 fail/error：分别归组', () => {
    const { failed, noData } = partitionQaResults([
      mk('pass'), mk('fail'), mk('error'), mk('no-data'), mk('no-data'),
    ]);
    expect(failed.map((r) => r.status)).toEqual(['fail', 'error']);
    expect(noData).toHaveLength(2);
    expect(noData.every((r) => r.status === 'no-data')).toBe(true);
  });

  it('全 pass 时两组皆空（只发"全部通过"告警）', () => {
    const { failed, noData } = partitionQaResults([mk('pass'), mk('pass')]);
    expect(failed).toHaveLength(0);
    expect(noData).toHaveLength(0);
  });

  it('只有 no-data 时 failed 为空（数据未到 ≠ 失败，不触发异常告警）', () => {
    const { failed, noData } = partitionQaResults([mk('no-data')]);
    expect(failed).toHaveLength(0);
    expect(noData).toHaveLength(1);
  });
});
