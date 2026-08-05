// web/lib/__tests__/collect.test.ts
// 铁律②：分页拉取失败同页重试 ≤2 次再跳过；间歇失败累计计数 pageFailures；fetchComplete（records>=apiTotal）判定保留。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectOnce } from '../collect';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeRecord(page: number, i: number): any {
  return {
    order_no: `O${page}-${i}`,
    order_detail_num: `${i}`,
    order_detail_bizday: '20260804',
    branch: { branch_num: 1, branch_code: '1', branch_name: 'b' },
    pos_item: { item_num: `I${page}`, item_code: `IC${page}`, pos_item_name: 'item', item_category: 'c', item_spec: '', item_unit: '' },
    state: 0,
  };
}

// Mock 乐檬 API + DuckDB：
//   count 恒返 600；分页 page_size=200 每页 200 条；page2 可配置失败次数（用于触发页级重试）。
function mockApi(page2FailTimes = 0) {
  let page2Attempts = 0;
  return vi.fn(async (url: string | URL, options?: RequestInit) => {
    const urlStr = String(url);
    const body = JSON.parse(String(options?.body));
    // DuckDB 写入
    if (urlStr.includes('/transform') || urlStr.includes('/merge')) {
      return jsonResp({ success: true, combined_file: 's3://lemeng-datasource/lemeng/retail_detail/unknown/2026-08-04/all.parquet', invalid_records: 0, duplicates_removed: 0 });
    }
    // 总数查询
    if (urlStr.includes('countposorderdetail')) {
      return jsonResp({ code: 0, result: 600 });
    }
    // 明细查询（预热 page_size=5 返回空；分页 page_size=200）
    if (urlStr.includes('findposorderdetail')) {
      if (body.page_size === 5) return jsonResp({ code: 0, result: [] }); // 预热
      const page = body.page_number;
      if (page === 2 && page2Attempts < page2FailTimes) {
        page2Attempts++;
        return new Response('Internal Server Error', { status: 500 });
      }
      return jsonResp({ code: 0, result: Array.from({ length: 200 }, (_, i) => makeRecord(page, i)) });
    }
    throw new Error('unexpected fetch url: ' + urlStr);
  });
}

describe('collectOnce 铁律② 页级重试', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('间歇页失败：同页重试 ≤2 次后成功，不丢页，pageFailures 计数', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 缩短随机 sleep，加快测试
    const fetchMock = mockApi(1); // 页2 首拉失败 1 次
    vi.stubGlobal('fetch', fetchMock);

    const r = await collectOnce('Bearer x', [1], '1', ['2026-08-04'], 200, { mode: 'full' });

    expect(r.apiTotal).toBe(600);
    expect(r.records.length).toBe(600); // 页2 经重试成功，未丢页
    expect(r.error).toBe('');
    expect(r.pageFailures).toBe(1);     // 仅 1 次失败尝试
  });

  it('持续页失败：重试 2 次仍失败则跳过该页，pageFailures 累计，fetchComplete 判定保留', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = mockApi(999); // 页2 恒失败（三次尝试全挂）
    vi.stubGlobal('fetch', fetchMock);

    const r = await collectOnce('Bearer x', [1], '1', ['2026-08-04'], 200, { mode: 'full' });

    expect(r.records.length).toBe(400); // 页2 被跳过（仅页1+页3，各 200）
    expect(r.pageFailures).toBe(3);     // 页2 三次尝试均失败
    expect(r.error).toBe('');           // 仅单页失败，consecutiveErrors 未达 3（交由 scheduler full 对账重试）
  });
});
