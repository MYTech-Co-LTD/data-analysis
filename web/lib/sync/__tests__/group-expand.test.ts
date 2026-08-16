// web/lib/sync/__tests__/group-expand.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({ casdoorFetch: vi.fn() }));
import { expandGroupsToBranches } from '../group-expand';

// maps_branch_group 经 casdoorFetch mock 返回（实现里经 PostgREST 读）
function mapsOf(rows: { group_id: string; group_type: string; branch_number: string | null; is_active: boolean }[]) {
  return rows;
}
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(async () => ({ data: [
    { group_id: '熊喵-东区',         group_type: 'region', branch_number: null,     is_active: true },
    { group_id: '熊喵-东区-3120-001', group_type: 'store',  branch_number: '3120-001', is_active: true },
    { group_id: '熊喵-东区-3120-002', group_type: 'store',  branch_number: '3120-002', is_active: true },
    { group_id: '熊喵-西区-3120-003', group_type: 'store',  branch_number: '3120-003', is_active: true },
    { group_id: '采购部',             group_type: 'dept',   branch_number: null,     is_active: true },
  ] })),
}));

describe('组类型三态展开（spec §5.3 H13）', () => {
  it('门店叶子组 → 直映 branch_number', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区-3120-001']);
    expect(r).toEqual({ branch_nums: ['3120-001'], ok: true });
  });
  it('区域组 → 子孙门店叶子并集', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区']);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '3120-002']);
  });
  it('部门组 → 不参与展开（空集但 ok，非 fail）', async () => {
    const r = await expandGroupsToBranches(['采购部']);
    expect(r).toEqual({ branch_nums: [], ok: true });
  });
  it('未知组 → fail-close（ok:false + error），空集结果仍返回但调用方须按 C2 处理', async () => {
    const r = await expandGroupsToBranches(['不存在的组']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown');
  });
  it('混合：store+region 并集去重；用户挂部门组+区域组 → 只区域贡献门店', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区-3120-001', '熊喵-东区', '采购部']);
    expect([...new Set(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '3120-002']);
  });
});
