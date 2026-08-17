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
// 模拟真实 casdoorFetch 返回（完整 body 结构 {status, data:[...]}）——2026-08-17 勘误：
// 旧 mock 返回 {data:[...]} 让 resp.data=数组 → fetchRemoteKeys 正确，掩盖了真实
// casdoorFetch 返回 {status,data:[...]}（resp.data=body 对象 → Array.isArray 恒 false → 空集）
// 的 bug。mock 必须与真实 body 结构一致才能捕获回归。
function remoteHas(names: string[]) { // get-resources 返回形态（fork 裸 name + description 存 catalog key 原文）
  return { status: 'ok', data: names.map((n) => ({ owner: 'shanhai', name: n.replace(/:/g, '_'), description: n })) };
}
// add-resource 成功响应（真实 Casdoor：HTTP 200 + body {status:'ok'}）
const addOk = { status: 'ok', data: 'Affected' };

describe('resource 同步 adapter（spec §5.1 ③，fork 裸 name 语义）', () => {
  it('差集只插缺口 + name 不加 "/" 前缀（fork 裸 name）', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas(['data-analysis:view:reports']));       // 现有
    mockFetch.mockResolvedValueOnce(addOk);                                           // add 成功
    const r = await syncResources('shanhai', ['data-analysis:view:reports', 'data-analysis:view:x']);
    expect(r.added).toEqual(['data-analysis:view:x']);
    expect(r.skippedExisting).toEqual(['data-analysis:view:reports']);
    expect(mockFetch).toHaveBeenLastCalledWith('/api/add-resource', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ owner: 'shanhai', name: '|data-analysis_view_x', description: 'data-analysis:view:x' }),
    }));
  });
  it('撞 PK（重复插入）→ 吞 duplicate 继续（幂等重跑 no-op）', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas([]));
    mockFetch.mockRejectedValueOnce(new Error('duplicate key'));  // 首插撞（并发窗口）
    mockFetch.mockResolvedValueOnce(remoteHas(['data-analysis:view:y'])); // retry 确认已被插过
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
  it('方案C：resource.name 用组|label（全量 catalog KEY_TO_DISPLAY_NAME）', async () => {
    mockFetch.mockClear();                                                 // 隔离前序测试的 mock 调用记录
    mockFetch.mockResolvedValueOnce(remoteHas([]));                        // 全缺
    mockFetch.mockResolvedValueOnce(addOk);                                // add view:reports
    mockFetch.mockResolvedValueOnce(addOk);                                // add field:cost
    mockFetch.mockResolvedValueOnce(addOk);                                // add view-board:brand
    const r = await syncResources('shanhai', [
      'data-analysis:view:reports',
      'data-analysis:field:cost',
      'data-analysis:view-board:brand',
    ]);
    expect(r.added).toEqual([
      'data-analysis:view:reports', 'data-analysis:field:cost', 'data-analysis:view-board:brand',
    ]);
    // name 用组|label（Casdoor 下拉显示）：看板|经营总览 / 字段|成本可见 / 看板|品牌×指标；description 恒存 key 原文
    const calls = mockFetch.mock.calls.filter((c) => c[0] === '/api/add-resource').map((c) => c[1].body);
    expect(JSON.parse(calls[0])).toMatchObject({ name: '看板|经营总览', description: 'data-analysis:view:reports' });
    expect(JSON.parse(calls[1])).toMatchObject({ name: '字段|成本可见', description: 'data-analysis:field:cost' });
    expect(JSON.parse(calls[2])).toMatchObject({ name: '看板|品牌×指标', description: 'data-analysis:view-board:brand' });
  });
});
