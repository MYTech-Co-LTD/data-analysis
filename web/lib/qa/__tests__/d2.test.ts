import { describe, it, expect } from 'vitest';
import { runD2 } from '../d2';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';

describe('runD2', () => {
  it('经 RPC 传 p_table 与 p_keys（聚合键）', async () => {
    const retail = detailSources.find((s) => s.name === 'retail')!;
    let called = null as any;
    const db = { rpc: async (fn: string, body: any) => { called = { fn, body }; return { data: [] }; } } as any;
    const { dupRows } = await runD2(db, retail);
    expect(called.fn).toBe('qa_d2_dup_rows');
    expect(called.body.p_table).toBe('report_daily_sales');
    expect(called.body.p_keys).toEqual(['system_book_code', 'branch_num', 'biz_date']);
    expect(dupRows).toEqual([]);
  });

  it('RPC 报错时 throw（不透传 error）', async () => {
    const retail = detailSources.find((s) => s.name === 'retail')!;
    const db = { rpc: async () => ({ data: undefined, error: { message: 'boom' } }) } as any;
    await expect(runD2(db, retail)).rejects.toThrow('qa_d2_dup_rows');
  });
});
