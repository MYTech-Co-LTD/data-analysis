// web/lib/collectors/lemeng/__tests__/index.test.ts
// Collector 插件适配层测试：验证 lemeng 插件把现有 collect*.ts 适配为统一 Collector 接口，
// 且 CollectResult 携带完整性五要素（不改采集业务逻辑，仅验证适配/映射）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { COLLECTORS } from '../../registry';
import type { CollectCtx, CollectOptions } from '../../../contracts';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeRecord(page: number, i: number): Record<string, unknown> {
  return {
    order_no: `O${page}-${i}`,
    order_detail_num: `${i}`,
    order_detail_bizday: '20260804',
    branch: { branch_num: 1, branch_code: '1', branch_name: 'b' },
    pos_item: { item_num: `I${page}`, item_code: `IC${page}`, pos_item_name: 'item', item_category: 'c', item_spec: '', item_unit: '' },
    state: 0,
  };
}

// Mock 乐檬 API + DuckDB（同 collect.test.ts 结构）：count 恒 600，page_size=200 每页 200 条
function mockApi() {
  return vi.fn(async (url: string | URL, options?: RequestInit) => {
    const urlStr = String(url);
    const body = JSON.parse(String(options?.body)) as { page_size?: number; page_number?: number };
    // DuckDB 写入
    if (urlStr.includes('/transform') || urlStr.includes('/merge')) {
      return jsonResp({ success: true, combined_file: 's3://lemeng-datasource/lemeng/retail_detail/unknown/2026-08-04/all.parquet', invalid_records: 0, duplicates_removed: 0 });
    }
    // 总数查询
    if (urlStr.includes('countposorderdetail')) return jsonResp({ code: 0, result: 600 });
    // 明细查询（预热 page_size=5 返回空；分页 page_size=200）
    if (urlStr.includes('findposorderdetail')) {
      if (body.page_size === 5) return jsonResp({ code: 0, result: [] }); // 预热
      const page = body.page_number ?? 1;
      return jsonResp({ code: 0, result: Array.from({ length: 200 }, (_, i) => makeRecord(page, i)) });
    }
    throw new Error('unexpected fetch url: ' + urlStr);
  });
}

describe('lemeng Collector 插件适配层', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('registry 注册 lemeng，kind 正确', () => {
    expect(COLLECTORS['lemeng']).toBeDefined();
    expect(COLLECTORS['lemeng'].kind).toBe('lemeng');
  });

  it('retail collectOnce：完整拉取映射出完整性五要素，detail 透传源结果', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 缩短随机 sleep，加快测试
    vi.stubGlobal('fetch', mockApi());

    const ctx: CollectCtx = { authToken: 'Bearer x', task: 'retail', branchNums: [1] };
    const opts: CollectOptions = { dates: ['2026-08-04'], mode: 'full', pageSize: 200 };

    const r = await COLLECTORS['lemeng'].collectOnce(ctx, opts);

    expect(r.fetchComplete).toBe(true);
    expect(r.upsertFailures).toBe(0);
    expect(r.verified).toBe(true);
    expect(r.softDeleteApplied).toBe(false);
    expect(r.alert).toBe(false);
    expect(r.error).toBeUndefined();
    const detail = r.detail as { records: unknown[]; apiTotal: number };
    expect(detail.records.length).toBe(600);
    expect(detail.apiTotal).toBe(600);
  });

  it('incremental 水位线跳过（skipped）：视为完整成功，不误报 alert', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', mockApi());

    const ctx: CollectCtx = { authToken: 'Bearer x', task: 'retail', branchNums: [1] };
    const opts: CollectOptions = { dates: ['2026-08-04'], mode: 'incremental', watermarkLastCount: 600 };

    const r = await COLLECTORS['lemeng'].collectOnce(ctx, opts);

    expect(r.fetchComplete).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.alert).toBe(false);
  });

  it('retail count：透传现有 countRetailApi（C0 对账用）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', mockApi());

    const ctx: CollectCtx = { authToken: 'Bearer x', task: 'retail', branchNums: [1] };
    const n = await COLLECTORS['lemeng'].count!(ctx, ['2026-08-04']);

    expect(n).toBe(600);
  });

  it('未知 task：fail-safe，alert=true 且 error 说明', async () => {
    const r = await COLLECTORS['lemeng'].collectOnce({ authToken: 'x', task: 'nope' } as CollectCtx, {});

    expect(r.alert).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.error).toContain('未知 task');
  });
});
