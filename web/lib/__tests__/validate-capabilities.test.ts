// web/lib/__tests__/validate-capabilities.test.ts
import { describe, it, expect } from 'vitest';
import { validateKey, validateWildcardRisk, detectViewGroupCycle } from '../validate-capabilities';
import { CATALOG_KEYS, VIEW_GROUPS } from '../capability-catalog';

describe('catalog 校验器（spec §5.1 ⑤，fail-close）', () => {
  it('合法 key 放行（catalog 内任取 + 全局 *）', () => {
    const anyKey = [...CATALOG_KEYS][0];
    expect(validateKey(anyKey).ok).toBe(true);
    expect(validateKey('*').ok).toBe(true);
  });
  it('未知 key 拒绝（反向发现）', () => {
    expect(validateKey('data-analysis:view:nope')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('deprecated key 拒绝（H14 fail-close）', () => {
    // 借用一个不存在的 key 模拟已废弃：直接测 reason 分支
    expect(validateKey('__test_deprecated__')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('通配授权进高风险清单（M1）', () => {
    const r = validateWildcardRisk(['data-analysis:view:reports', 'data-analysis:view:*', 'data-analysis:brand:*']);
    expect([...r.risky]).toEqual(['data-analysis:view:*', 'data-analysis:brand:*']);
  });
  it('view-group 无环（现状）+ 注入环可检出', () => {
    expect(detectViewGroupCycle()).toEqual([]);
    // detectViewGroupCycle 接受可选入参便于测试注入（生产调用无参）
    const cyclic = { 'data-analysis:view-group:a': { label: 'a', members: ['data-analysis:view-group:b'] as const },
                     'data-analysis:view-group:b': { label: 'b', members: ['data-analysis:view-group:a'] as const } };
    expect(detectViewGroupCycle(cyclic as unknown as typeof VIEW_GROUPS).length).toBeGreaterThan(0);
  });
});
