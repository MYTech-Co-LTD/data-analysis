// web/lib/push/__tests__/scope-consistency.test.ts
// M12/spec-forge：JS 解析（scope-expand.ts）与 SQL 解析（get_user_perms，migration 200）「同输入同输出」
// 契约——用受控 fixture 数据集生成 golden 期望，断言 JS 侧产出；SQL 侧在 database/tests/200_... 断言
// 同一组键形态 → 同一输出（生产/部署时跑）。防 JS/SQL 解析漂移。
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../sync/casdoor-client', () => ({
  casdoorFetch: vi.fn(async (url: string) => {
    if (url.includes('dim_branch')) {
      return { data: [
        { branch_number: '3120-0006', branch_name: '武汉光谷店' },
        { branch_number: '64188-0006', branch_name: '武汉光谷店' },   // 重名（跨 sbc）
        { branch_number: '3120-0010', branch_name: '常德武陵店' },
      ] };
    }
    return { data: [
      { group_id: '东部二区', branch_number: '3120-0001' },
      { group_id: '东部二区', branch_number: '3120-0002' },
      { group_id: '东部二区', branch_number: '3120-0003' },
      { group_id: '中部三区', branch_number: '3120-0082' },   // 令东部二区 ≠ universe（防误收敛）
    ] };
  }),
}));
import { expandScopeResources } from '../../sync/scope-expand';

// golden fixture：与 database/tests/200_... 的键形态一一对应（全店/分区包/branch_number/中文名/未知/重名/空集/收敛）
//   SQL 侧期望（迁移 200 语义）与下表一致；此测试在 CI 无 DB 时钉 JS 侧，部署时钉 SQL 侧，双侧同 golden。
describe('JS/SQL 解析一致性（同输入同输出）', () => {
  it('全店键 → ["*"]（唯一通配，M2）', async () => {
    expect((await expandScopeResources(['全店'])).branch_nums).toEqual(['*']);
    expect((await expandScopeResources(['*'])).branch_nums).toEqual(['*']);
  });

  it('分区包 → 包内门店并集（东部二区 fixture → 3 店，≠universe 不误收敛）', async () => {
    const r = await expandScopeResources(['东部二区']);
    expect(r.ok).toBe(true);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-0001', '3120-0002', '3120-0003']);
  });

  it('branch_number 直映（maps 内真实门店）', async () => {
    expect((await expandScopeResources(['3120-0001'])).branch_nums).toEqual(['3120-0001']);
  });

  it('中文名唯一命中', async () => {
    expect((await expandScopeResources(['常德武陵店'])).branch_nums).toEqual(['3120-0010']);
  });

  it('中文名重名 → fail-close（golden：ok:false）', async () => {
    const r = await expandScopeResources(['武汉光谷店']);
    expect(r.ok).toBe(false);
  });

  it('未知键 → fail-close（golden：ok:false）', async () => {
    const r = await expandScopeResources(['不存在的包']);
    expect(r.ok).toBe(false);
  });

  it('空键 → { branch_nums: [], ok: true }（空集=authorized ∅，B1 deny）', async () => {
    expect(await expandScopeResources([])).toEqual({ branch_nums: [], ok: true });
  });

  it('覆盖 maps 全集 → 收敛 ["*"]（collapseFullStore）', async () => {
    // maps 全集 = 东部二区3 + 中部三区1 = 4 店；全部覆盖 → ['*']
    const r = await expandScopeResources(['东部二区', '中部三区']);
    expect(r.ok).toBe(true);
    expect(r.branch_nums).toEqual(['*']);
  });
});
