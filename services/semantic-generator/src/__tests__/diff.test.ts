import { describe, it, expect } from 'vitest';
import { sumDiff } from '../diff.js';

describe('sumDiff', () => {
  it('各列 SUM 相等 → diff 全 0', () => {
    const oldRows = [{ a: 10, b: 20 }, { a: 5, b: 7 }];
    const newRows = [{ a: 13, b: 25 }, { a: 2, b: 2 }];
    const d = sumDiff(oldRows, newRows, ['a', 'b']);
    expect(d).toEqual([
      { col: 'a', oldSum: 15, newSum: 15, diff: 0 },
      { col: 'b', oldSum: 27, newSum: 27, diff: 0 },
    ]);
  });

  it('列不等 → diff 非零', () => {
    const d = sumDiff([{ x: 100 }], [{ x: 90 }], ['x']);
    expect(d[0].diff).toBe(10);
  });

  it('null 值按 0 计', () => {
    const d = sumDiff([{ x: null }], [{ x: 5 }], ['x']);
    expect(d[0].oldSum).toBe(0);
    expect(d[0].diff).toBe(-5);
  });
});
