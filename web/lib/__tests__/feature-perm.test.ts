// web/lib/__tests__/feature-perm.test.ts
// checkFeaturePerm 单模块（plan Task 3 Step 1，spec §6.2）：
// claims 命中 true / BREAKGLASS 命中 true+审计 / 双无 false。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkFeaturePerm } from '../feature-perm';

afterEach(() => {
  delete process.env.BREAKGLASS_ADMINS;
  vi.restoreAllMocks();
});

describe('checkFeaturePerm', () => {
  it('claims 含权限 → true', async () => {
    expect(await checkFeaturePerm('u1', 'data-analysis:admin',
      { permissions: ['data-analysis:admin'] })).toBe(true);
  });

  it('无 claims 但在 BREAKGLASS → true 且记审计', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BREAKGLASS_ADMINS = 'u9';
    expect(await checkFeaturePerm('u9', 'data-analysis:admin')).toBe(true);
    expect(warn).toHaveBeenCalledWith('[breakglass]', 'u9', 'data-analysis:admin');
  });

  it('两者皆无 → false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkFeaturePerm('u1', 'data-analysis:admin', {})).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
