import { describe, it, expect } from 'vitest';
import { targetRatio, ratioAchievement, formatRatio } from '../ratio';

describe('targetRatio', () => {
  it('正常比值', () => {
    expect(targetRatio(2000, 5000)).toBeCloseTo(0.4);
  });
  it('销售目标为 0 返回 null（除零）', () => {
    expect(targetRatio(2000, 0)).toBeNull();
  });
  it('配送为 0 返回 0', () => {
    expect(targetRatio(0, 5000)).toBe(0);
  });
});

describe('ratioAchievement', () => {
  it('正常 = 实际配销比/目标配销比', () => {
    // actual 2250/4500=0.5, target 2000/5000=0.4 → 1.25
    expect(ratioAchievement(2250, 4500, 2000, 5000)).toBeCloseTo(1.25);
  });
  it('目标销售为 0 → null', () => {
    expect(ratioAchievement(100, 200, 100, 0)).toBeNull();
  });
  it('实际销售为 0 → null', () => {
    expect(ratioAchievement(100, 0, 100, 200)).toBeNull();
  });
  it('配送目标为 0 返回 null', () => {
    expect(ratioAchievement(100, 200, 0, 500)).toBeNull();
  });
});

describe('formatRatio', () => {
  it('null → —', () => {
    expect(formatRatio(null)).toBe('—');
  });
  it('0.4 → 40%', () => {
    expect(formatRatio(0.4)).toBe('40%');
  });
  it('1.128 → 113%（toFixed0 四舍五入）', () => {
    expect(formatRatio(1.128)).toBe('113%');
  });
  it('0 → 0%', () => {
    expect(formatRatio(0)).toBe('0%');
  });
});
