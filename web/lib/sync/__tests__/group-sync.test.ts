// web/lib/sync/__tests__/group-sync.test.ts
// 组同步器单测（Task 8 Step 1；plan 2026-08-16-platform-iam-standardization.md L765-816 逐字基线）。
// 覆盖 H1（先父后子/父链校验）+ H2（两通道分离——门店树 diff 驱动）+ 删除限自建。
// 相对 plan 原文的适配（均已在 report 记录）：
//   - test4 的 require() → ESM import（vitest ESM 环境 + 仓库既有测试惯例）
//   - test2 补 vi.stubGlobal('fetch')：maps_branch_group 走全局 fetch（PostgREST），非 casdoorFetch，
//     不 stub 会因相对 URL 直接 TypeError
//   - test1/test2 各补一条强化断言（父组先于子组的 body 级证据 / maps 写入的 body 级证据）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../casdoor-client', () => ({ casdoorFetch: vi.fn() }));
import { casdoorFetch } from '../casdoor-client';
import { upsertGroup, syncStoreTree, verifyParentChain, deletableGroups } from '../group-sync';

const mockFetch = casdoorFetch as unknown as ReturnType<typeof vi.fn>;
const groupList = (names: {name: string; parentId?: string}[]) =>
  ({ data: names.map((n, i) => ({ owner: 'shanhai', name: n.name, id: `g${i}`, parentId: n.parentId ?? '', type: 'Virtual' })) });

describe('组同步器（spec §5.3，H1/H2）', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('建树先父后子：父组请求先于子组（H1——后序会触发 GetUserFullGroupPath error 整组登录崩）', async () => {
    mockFetch.mockResolvedValueOnce(groupList([]));                    // 现有组=空
    mockFetch.mockResolvedValue({ data: { id: 'ok' } });               // add-group 全成功
    const calls: string[] = [];
    const bodies: string[] = [];
    mockFetch.mockImplementation((path: string, init?: RequestInit) => {
      calls.push(path);
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve({ data: {} });
    });
    await upsertGroup('shanhai', '熊喵-东区-门店A', '熊喵-东区', 'store');
    const firstAdd = calls.findIndex((c) => c.includes('add-group'));
    expect(firstAdd).toBeGreaterThanOrEqual(0);
    // 父组（熊喵-东区）的 add 必须出现在子组（门店A）之前
    const parentAdd = calls.findIndex((c) => c.includes('add-group'));
    expect(parentAdd).toBeLessThanOrEqual(firstAdd);
    // 强化（body 级证据）：name="熊喵-东区" 的 add 请求先于 name="熊喵-东区-门店A"
    const parentIdx = bodies.findIndex((b) => b.includes('"name":"熊喵-东区"'));
    const childIdx = bodies.findIndex((b) => b.includes('"name":"熊喵-东区-门店A"'));
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeLessThan(childIdx);
    // 子组 parentId 存父 Name（Casdoor 组父子链按 name 引用）
    expect(bodies[childIdx]).toContain('"parentId":"熊喵-东区"');
  });
  it('门店树 diff 驱动：dim_branch 新店 → 建 store 组 + 写 maps_branch_group；旧店改名 → 新名 upsert + 旧映射 is_active=false（H2）', async () => {
    // dim_branch 返回 3120-999 新店；maps 空；group 树空
    const fetchOrder: any[] = [];
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      fetchOrder.push({ path, body: init?.body });
      if (path.includes('get-branches')) return { data: [{ branch_number: '3120-999', branch_name: '新店' }] };
      if (path.includes('get-groups')) return groupList([]);
      return { data: { id: 'new-g' } };
    });
    // PostgREST（maps_branch_group）走全局 fetch，非 casdoorFetch——须单独 stub
    const postgrestCalls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      postgrestCalls.push({ url: String(url), method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (init?.method === 'POST') return { ok: true };
      return { json: async () => [] };                                 // maps 现状 = 空
    }));
    const r = await syncStoreTree();
    expect(r.created).toEqual([{ branch_number: '3120-999', group_name: expect.stringContaining('3120-999') }]);
    // 强化（body 级证据）：确实写了 maps_branch_group，且带 branch_number / source='auto'（H15 审计归因）
    const mapsPost = postgrestCalls.find((c) => c.method === 'POST' && c.url.includes('maps_branch_group'));
    expect(mapsPost).toBeDefined();
    expect(mapsPost?.body).toContain('"branch_number":"3120-999"');
    expect(mapsPost?.body).toContain('"source":"auto"');
  });
  it('父链断裂检出（H1）：parentId 指向不存在组 → broken 非空', () => {
    const broken = verifyParentChain([
      { name: '孤儿组', parentId: '不存在' },
    ]);
    expect(broken).toEqual([{ group: '孤儿组', parent: '不存在' }]);
  });
  it('删除限于自建组（isCreatedBySyncer 标记）：非同步器建的组不进 delete 候选', () => {
    expect(deletableGroups([
      { name: 'auto-g', properties: JSON.stringify({ createdBy: 'group-sync' }) },
      { name: 'human-g', properties: '' },
    ])).toEqual(['auto-g']);
  });
});
