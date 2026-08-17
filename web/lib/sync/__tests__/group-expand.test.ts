// web/lib/sync/__tests__/group-expand.test.ts
// 2026-08-17 组树迁移企微部门树后语义（与 claims.js resolveGroupBranches 对齐）：
//   部门组多行映射（新形态）任一命中行贡献门店；旧 store/region 形态保留兼容；未知组 fail-close。
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(async () => ({ data: [
    // 旧形态（门店组过渡兼容）：region 父 + store 叶子
    { group_id: '熊喵-东区',         group_type: 'region', branch_number: null,     is_active: true },
    { group_id: '熊喵-东区-3120-001', group_type: 'store',  branch_number: '3120-001', is_active: true },
    { group_id: '熊喵-东区-3120-002', group_type: 'store',  branch_number: '3120-002', is_active: true },
    { group_id: '熊喵-西区-3120-003', group_type: 'store',  branch_number: '3120-003', is_active: true },
    // 新形态（部门组多行映射，group_type='dept'）：辖区部门两行 + 职能部门全店示意两行
    { group_id: '东部战区', group_type: 'dept', branch_number: '64188-001', is_active: true },
    { group_id: '东部战区', group_type: 'dept', branch_number: '64188-002', is_active: true },
    { group_id: '财务部',   group_type: 'dept', branch_number: '64188-001', is_active: true },
    { group_id: '财务部',   group_type: 'dept', branch_number: '64188-002', is_active: true },
    { group_id: '财务部',   group_type: 'dept', branch_number: '3120-003', is_active: true },
  ] })),
}));
import { expandGroupsToBranches } from '../group-expand';

describe('组→门店展开（2026-08-17 部门组语义 + 旧形态兼容）', () => {
  it('部门组（新形态）→ 多行映射全部贡献（战区部门=辖区门店）', async () => {
    const r = await expandGroupsToBranches(['shanhai/山海一果/东部战区']);
    expect(r).toEqual({ branch_nums: ['64188-001', '64188-002'], ok: true });
  });
  it('全路径入参 → 尾段截取后按组名命中（token/F9 投影同源形态）', async () => {
    const r = await expandGroupsToBranches(['shanhai/山海一果/财务部']);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-003', '64188-001', '64188-002']);
  });
  it('门店叶子组（旧形态）→ 直映 branch_number', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区-3120-001']);
    expect(r).toEqual({ branch_nums: ['3120-001'], ok: true });
  });
  it('区域组（旧形态）→ 前缀 store 子孙并集', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区']);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '3120-002']);
  });
  it('未知组 → fail-close（ok:false + error）', async () => {
    const r = await expandGroupsToBranches(['不存在的组']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown');
  });
  it('混合：部门组+旧门店叶并集去重', async () => {
    const r = await expandGroupsToBranches(['shanhai/东部战区', '熊喵-东区-3120-001']);
    expect([...new Set(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '64188-001', '64188-002']);
  });
});
