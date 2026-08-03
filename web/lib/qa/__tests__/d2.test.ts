import { describe, it, expect } from 'vitest';
import { runD2 } from '../d2';
import detailSources from '../config/detail-sources.json';
import type { DetailSource } from '../types';

describe('runD2', () => {
  const retail = detailSources.find((s) => s.name === 'retail')! as DetailSource;

  it('经 RPC 传 p_table 与 p_keys（聚合键）', async () => {
    let called = null as any;
    const db = { rpc: async (fn: string, body: any) => { called = { fn, body }; return { data: [] }; } } as any;
    const { dupRows } = await runD2(db, retail);
    expect(called.fn).toBe('qa_d2_dup_rows');
    expect(called.body.p_table).toBe('report_daily_sales');
    expect(called.body.p_keys).toEqual(['system_book_code', 'branch_num', 'biz_date']);
    expect(dupRows).toEqual([]);
  });

  it('RPC 报错时 throw（不透传 error）', async () => {
    const db = { rpc: async () => ({ data: undefined, error: { message: 'boom' } }) } as any;
    await expect(runD2(db, retail)).rejects.toThrow('qa_d2_dup_rows');
  });

  it('兼容 rpc 适配器裸数组返回（SETOF RPC 的 PostgREST 裸数组形态）', async () => {
    const db = { rpc: async () => [{ dup_key: '3120|1|2026-07-28', cnt: 2 }] } as any;
    const { dupRows } = await runD2(db, retail);
    expect(dupRows).toEqual([{ dup_key: '3120|1|2026-07-28', cnt: 2 }]);
  });
});
