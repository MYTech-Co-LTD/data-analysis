import { describe, it, expect } from 'vitest';
import { actualRatio, targetRatio, ratioAchievement, formatRatio, marginAchievement, absoluteThreeColor } from '../ratio';

describe('actualRatio', () => {
  it('正常 = 配送/销售', () => {
    expect(actualRatio(2000, 5000)).toBeCloseTo(0.4);
  });
  it('销售为 0 返回 null（除零）', () => {
    expect(actualRatio(2000, 0)).toBeNull();
  });
  it('配送为 0 返回 0', () => {
    expect(actualRatio(0, 5000)).toBe(0);
  });
});

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

describe('marginAchievement', () => {
  it('正常 = 毛利率/目标', () => {
    expect(marginAchievement(0.18, 0.12)).toBeCloseTo(1.5);
  });
  it('默认目标 0.12', () => {
    expect(marginAchievement(0.12)).toBeCloseTo(1);
  });
  it('null 毛利率（脱敏）→ null', () => {
    expect(marginAchievement(null)).toBeNull();
  });
  it('负毛利（亏损）→ 负达成率', () => {
    expect(marginAchievement(-0.05, 0.12)).toBeCloseTo(-0.416666, 5);
  });
  it('目标 0 → null（除零保护）', () => {
    expect(marginAchievement(0.18, 0)).toBeNull();
  });
});

describe('absoluteThreeColor', () => {
  it('>=1 绿', () => {
    expect(absoluteThreeColor(1)).toBe('text-green-600');
    expect(absoluteThreeColor(1.5)).toBe('text-green-600');
  });
  it('>=0.8 琥珀', () => {
    expect(absoluteThreeColor(0.8)).toBe('text-amber-600');
    expect(absoluteThreeColor(0.99)).toBe('text-amber-600');
  });
  it('<0.8 红', () => {
    expect(absoluteThreeColor(0.79)).toBe('text-red-600');
    expect(absoluteThreeColor(0)).toBe('text-red-600');
    expect(absoluteThreeColor(-1)).toBe('text-red-600');
  });
  it('null → 灰', () => {
    expect(absoluteThreeColor(null)).toBe('text-slate-300');
  });
});
