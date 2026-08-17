// web/lib/__tests__/feature-perm.test.ts
// checkFeaturePerm 单模块（plan Task 3 Step 1，spec §6.2）：
// claims 命中 true / BREAKGLASS 命中 true+审计 / 双无 false。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkFeaturePerm, hasBoardPerm, hasKpiPerm } from '../feature-perm';

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

describe('hasBoardPerm / hasKpiPerm（看板/KPI 卡片级能力）', () => {
  it('具名命中 → true', () => {
    expect(hasBoardPerm(['data-analysis:view-board:kpi'], 'kpi')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view-kpi:sale'], 'sale')).toBe(true);
  });
  it('命名空间通配 view-board:* / view-kpi:* → true', () => {
    expect(hasBoardPerm(['data-analysis:view-board:*'], 'region')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view-kpi:*'], 'outbound_margin')).toBe(true);
  });
  it('全局 * → true', () => {
    expect(hasBoardPerm(['*'], 'kpi')).toBe(true);
    expect(hasKpiPerm(['*'], 'delivery')).toBe(true);
  });
  it('未配置任何该命名空间能力（旧 token/无登录）→ 默认全开（fail-open，避免上线即收权）', () => {
    expect(hasBoardPerm(undefined, 'kpi')).toBe(true);
    expect(hasBoardPerm([], 'kpi')).toBe(true);
    // 旧 token 有 20 个 view/field 等权限但不含 view-board → 全开（不因旧 token 误伤）
    expect(hasBoardPerm(['data-analysis:view:reports', 'data-analysis:field:cost'], 'region')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view:reports'], 'sale')).toBe(true);
    // view:* 不等于 view-board:*（命名空间隔离）
    expect(hasBoardPerm(['data-analysis:view:kpi'], 'kpi')).toBe(true); // 但未配置 view-board → 仍全开
  });
  it('已配置部分能力 → 只裁剪到配置集（收权生效）', () => {
    const perms = ['data-analysis:view-board:kpi', 'data-analysis:view-board:region']; // 只配 2 看板
    expect(hasBoardPerm(perms, 'kpi')).toBe(true);
    expect(hasBoardPerm(perms, 'region')).toBe(true);
    expect(hasBoardPerm(perms, 'brand')).toBe(false);   // 未配的看板被收权
    expect(hasBoardPerm(perms, 'wholesale')).toBe(false);
    const kperms = ['data-analysis:view-kpi:sale', 'data-analysis:view-kpi:delivery'];
    expect(hasKpiPerm(kperms, 'sale')).toBe(true);
    expect(hasKpiPerm(kperms, 'outbound_amt')).toBe(false);
  });
  it('未知 boardId/code（单真相防御）→ false', () => {
    expect(hasBoardPerm(['data-analysis:view-board:*'], 'nonexistent')).toBe(false);
    expect(hasKpiPerm(['data-analysis:view-kpi:*'], 'nonexistent')).toBe(false);
  });
});
