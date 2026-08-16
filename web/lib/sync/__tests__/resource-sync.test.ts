// web/lib/sync/__tests__/resource-sync.test.ts
// W1 Task4：resource 同步 adapter 单测（mock casdoorFetch，不真调 Casdoor）。
// 勘误（T4 实施取证，2026-08-16）：plan 原文 retry mock 写 { name: '/y' }，denorm 后 'y' 与 key
// 'data-analysis:view:y' 永不匹配 → 逐字照抄必红；按注释「retry 成功」意图修正为完整 key。
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(),
}));
import { casdoorFetch } from '../casdoor-client';
import { syncResources } from '../resource-sync';

const mockFetch = casdoorFetch as unknown as ReturnType<typeof vi.fn>;
function remoteHas(names: string[]) { // get-resources 返回形态（name 恒带 / 前缀——H3 怪癖）
  return { data: names.map((n) => ({ owner: 'shanhai', name: n })) };
}

describe('resource 同步 adapter（spec §5.1 ③ H3 怪癖）', () => {
  it('差集只插缺口 + name 统一加 "/" 前缀', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas(['/data-analysis:view:reports']));       // 现有
    mockFetch.mockResolvedValueOnce({ data: [{ owner: 'shanhai', name: '/x' }] });    // add 成功
    const r = await syncResources('shanhai', ['data-analysis:view:reports', 'data-analysis:view:x']);
    expect(r.added).toEqual(['data-analysis:view:x']);
    expect(r.skippedExisting).toEqual(['data-analysis:view:reports']);
    expect(mockFetch).toHaveBeenLastCalledWith('/api/add-resource', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ owner: 'shanhai', name: '/data-analysis:view:x' }),  // ← 前缀归一
    }));
  });
  it('撞 PK（重复插入）→ 吞 duplicate 继续（幂等重跑 no-op）', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas([]));
    mockFetch.mockRejectedValueOnce(new Error('duplicate key'));  // 首插撞（并发窗口）
    mockFetch.mockResolvedValueOnce(remoteHas(['/data-analysis:view:y'])); // retry 确认已被插过
    const r = await syncResources('shanhai', ['data-analysis:view:y']);
    expect(r.added).toEqual(['data-analysis:view:y']);
    expect(r.failed).toEqual([]);
  });
  it('同步失败不静默（L2）：逐 key 结果进 failed，不 throw 中断整批', async () => {
    // 勘误 #2（T4 实施取证，2026-08-16）：plan 原文 mock 链漏算「add 失败后 retry 重读 get-resources」
    // 的调用——第 3 个 rejection 被 key1 的 retry 消耗，key2 的 add 落到 mock 耗尽区（返回 undefined
    // 被误判成功）。按实现真实调用序补齐 retry 响应，测试意图不变：两 key 都失败、都进 failed。
    mockFetch.mockResolvedValueOnce(remoteHas([]));               // get-resources 初始
    mockFetch.mockRejectedValueOnce(new Error('charset?'));      // add category:水果 被拒
    mockFetch.mockResolvedValueOnce(remoteHas([]));               // retry get-resources（水果）→ 仍缺
    mockFetch.mockRejectedValueOnce(new Error('network down'));   // add view:z 失败
    mockFetch.mockResolvedValueOnce(remoteHas([]));               // retry get-resources（z）→ 仍缺
    const r = await syncResources('shanhai', ['data-analysis:category:水果', 'data-analysis:view:z']);
    expect(r.failed.map((f) => f.key)).toEqual(['data-analysis:category:水果', 'data-analysis:view:z']);
  });
});
