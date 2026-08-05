import { describe, it, expect, vi } from 'vitest';
import { runQaChecks } from '../qa-runner';
import detailSources from '../qa/config/detail-sources.json';

function makeDb(overrides: Record<string, unknown> = {}) {
  const inserted: unknown[] = [];
  const db = {
    rpc: vi.fn(async () => ({ data: [] })),
    from: vi.fn((t: string) => {
      // 链式 thenable query builder（C5 会调 .select().eq().single()）
      const qb = {
        select: vi.fn(() => qb),
        eq: vi.fn(() => qb),
        single: vi.fn(() => qb),
        order: vi.fn(() => qb),
        limit: vi.fn(() => qb),
        insert: vi.fn(async (rows: unknown[]) => { inserted.push(...(rows as unknown[])); return { data: rows, error: null }; }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return qb;
    }),
    _inserted: inserted,
    ...overrides,
  };
  return db as any;
}

describe('runQaChecks', () => {
  it('D1 全部通过时记 pass，写 qa_logs', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-1', trigger: 'cron', db, duck });
    // D1 只跑原始三源（item 源 natural_key 不适用，跳过）；D2 覆盖全部源（聚合表 PK 检查）
    const raw3 = detailSources.filter((s) => ['retail', 'delivery', 'wholesale'].includes(s.name));
    expect(results.filter((r) => r.check_type === 'D1' && r.status === 'pass').length).toBe(raw3.length);
    expect(results.filter((r) => r.check_type === 'D2' && r.status === 'pass').length).toBe(detailSources.length);
    expect(db._inserted.length).toBeGreaterThan(0);
  });

  it('D1 跳过 item 源：C1:item_sales 定向也不会跑 D1', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-skip-item', trigger: 'cron', db, duck, checks: ['D1:item_sales'] });
    expect(results.filter((r) => r.check_type === 'D1')).toHaveLength(0);
    // C1 不会因 D1 定向触发；D2 因 want('D2','item_sales') 未命中也不跑
    expect(results).toHaveLength(0);
  });

  it('D1 跳过 item_outbound：D1:item_outbound 定向不产生结果（natural_key=[] 不适用）', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-skip-item-ob', trigger: 'cron', db, duck, checks: ['D1:item_outbound'] });
    expect(results.filter((r) => r.check_type === 'D1')).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it('D2 覆盖 item 源：D2:item_sales 跑 RPC 检查聚合表 PK', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-d2-item', trigger: 'cron', db, duck, checks: ['D2:item_sales'] });
    const d2 = results.find((r) => r.check_type === 'D2' && r.check_name === 'item_sales');
    expect(d2?.status).toBe('pass');
    // RPC 收到聚合表与键
    expect(db.rpc).toHaveBeenCalledWith('qa_d2_dup_rows', { p_table: 'report_daily_item_sales', p_keys: ['system_book_code', 'item_num', 'biz_date'] });
  });

  it('D1 有重复行记 fail 且 diff=重复行数', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    duck.mockImplementation(async (sql: string) =>
      sql.includes('retail_detail')
        ? [{ system_book_code: '3120', bizday: '20260728', total_rows: 120, distinct_rows: 2 }]
        : []);
    const results = await runQaChecks({ runId: 'test-2', trigger: 'manual', db, duck, checks: ['D1:retail'] });
    const d1 = results.find((r) => r.check_type === 'D1');
    expect(d1?.status).toBe('fail');
    expect(d1?.diff).toBe(1);
  });

  it('C2 视图查询报错记 error 不静默 pass', async () => {
    const db = makeDb({
      from: vi.fn((t: string) => {
        const qb = {
          select: vi.fn(() => qb),
          eq: vi.fn(() => qb),
          single: vi.fn(() => qb),
          order: vi.fn(() => qb),
          limit: vi.fn(() => qb),
          insert: vi.fn(async (rows: unknown[]) => { (db as any)._inserted.push(...(rows as unknown[])); return { data: rows, error: null }; }),
          then: (resolve: (v: unknown) => void) => resolve(t.endsWith('_qa') ? { data: undefined, error: 'relation does not exist' } : { data: [], error: null }),
        };
        return qb;
      }),
    });
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-4', trigger: 'manual', db, duck });
    const c2 = results.find((r) => r.check_type === 'C2');
    expect(c2?.status).toBe('error');
  });

  it('checks 过滤生效', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-3', trigger: 'cron', db, duck, checks: ['D2:retail'] });
    expect(results.length).toBe(1);
    expect(results[0].check_type).toBe('D2');
    expect(results[0].check_name).toBe('retail');
  });

  it('C4 定向：checks=[C4:semantic-registry] 只跑 C4（registry 静态校验 pass）', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-c4', trigger: 'cron', db, duck, checks: ['C4:semantic-registry'] });
    expect(results).toHaveLength(1);
    const c4 = results[0];
    expect(c4.check_type).toBe('C4');
    expect(c4.check_name).toBe('semantic-registry');
    expect(c4.status).toBe('pass');
    // execute_sql 适配：查询包 to_jsonb 调 validate_semantic_registry
    expect(db.rpc).toHaveBeenCalledWith('execute_sql', {
      query: 'SELECT to_jsonb(q) FROM (SELECT * FROM validate_semantic_registry()) AS q',
    });
  });

  it('C4 默认注入：无 checks 时 runQaChecks 含 C4 且空 issue = pass', async () => {
    const db = makeDb();
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-c4-default', trigger: 'cron', db, duck });
    const c4 = results.find((r) => r.check_type === 'C4' && r.check_name === 'semantic-registry');
    expect(c4?.status).toBe('pass');
    expect(c4?.diff).toBe(0);
  });

  it('C4 有 issue 时记 fail 且 diff=issue 数', async () => {
    const db = makeDb({
      rpc: vi.fn(async () => ({
        data: [{ to_jsonb: { issue: 'derived 指标 m2 依赖未定义指标 m3' } }],
      })),
    });
    const duck = vi.fn(async (_sql: string): Promise<Record<string, unknown>[]> => []);
    const results = await runQaChecks({ runId: 'test-c4-fail', trigger: 'cron', db, duck, checks: ['C4:semantic-registry'] });
    const c4 = results.find((r) => r.check_type === 'C4');
    expect(c4?.status).toBe('fail');
    expect(c4?.diff).toBe(1);
    expect((c4?.detail as any[])[0]).toEqual({ issue: 'derived 指标 m2 依赖未定义指标 m3' });
  });
});
