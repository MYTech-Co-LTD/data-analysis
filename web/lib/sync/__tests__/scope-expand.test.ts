// web/lib/sync/__tests__/scope-expand.test.ts
// 2026-08-18 门店范围唯一真相：范围|X 资源键 → 门店集展开（与 claims.js resolveScopeKeys + collapseFullStore
// 同语义的 web 版）。供权限预览对齐真实登录；契约测试防与 function 侧口径漂移。
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(async (url: string) => {
    if (url.includes('dim_branch')) {
      return { data: [
        { branch_number: '3120-0006', branch_name: '武汉光谷店' },
        { branch_number: '3120-0010', branch_name: '常德武陵店' },
        { branch_number: '3120-0082', branch_name: '长沙岳麓店' },
        { branch_number: '3120-0006', branch_name: '武汉光谷店' },   // 重名门店（另一品牌同名示意）
        { branch_number: '64188-0006', branch_name: '武汉光谷店' },
      ] };
    }
    return { data: [
      { group_id: '中部一区', branch_number: '3120-0006' },
      { group_id: '中部一区', branch_number: '3120-0010' },
      { group_id: '中部三区', branch_number: '3120-0082' },
      { group_id: '中部二区', branch_number: '3120-0099' },
    ] };
  }),
}));
import { expandScopeResources } from '../scope-expand';

describe('范围|X 键 → 门店集展开（2026-08-18 门店范围唯一真相）', () => {
  it('包名 → 包内门店并集（dept 多行映射）', async () => {
    const r = await expandScopeResources(['中部一区', '中部三区']);
    expect(r.ok).toBe(true);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-0006', '3120-0010', '3120-0082']);
  });
  it('通配 * / 中文别名全店 → ["*"] 短路', async () => {
    expect((await expandScopeResources(['*'])).branch_nums).toEqual(['*']);
    expect((await expandScopeResources(['全店'])).branch_nums[0]).toBe('*');
  });
  it('branch_number 直映', async () => {
    const r = await expandScopeResources(['3120-0006']);
    expect(r.branch_nums).toEqual(['3120-0006']);
  });
  it('门店中文名唯一命中（dim_branch.branch_name）', async () => {
    const r = await expandScopeResources(['常德武陵店']);
    expect(r.branch_nums).toEqual(['3120-0010']);
  });
  it('门店中文名重名 → fail-close（ok:false）', async () => {
    const r = await expandScopeResources(['武汉光谷店']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ambiguous');
  });
  it('未知键 → fail-close', async () => {
    const r = await expandScopeResources(['不存在的包']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown');
  });
  it('空键数组 → { branch_nums: [], ok: true }（空集=authorized ∅，上层 deny）', async () => {
    const r = await expandScopeResources([]);
    expect(r).toEqual({ branch_nums: [], ok: true });
  });
  it('全店覆盖 maps 门店全集 → 收敛 ["*"]（collapseFullStore 同款）', async () => {
    // maps 全集 = 3120-0006/0010/0082/0099，全部覆盖 → ['*']
    const r = await expandScopeResources(['中部一区', '中部三区', '中部二区']);
    expect(r.branch_nums).toEqual(['*']);
  });
  it('部分覆盖 → 明细列表（不外溢）', async () => {
    const r = await expandScopeResources(['中部三区']);
    expect(r.branch_nums).toEqual(['3120-0082']);
  });
});
