// web/lib/qa/__tests__/c4-runner.test.ts
// C4 runner 单测：mock db.rpc(execute_sql) 返 validate_semantic_registry issue 行，
// 验证空=pass / 有 issue=fail / to_jsonb 解包 / 错误兜底 / 定向过滤 / qa_logs 写入。
import { describe, it, expect, vi } from 'vitest';
import { runC4Checks, C4_CHECK_NAME } from '../c4-runner';

function makeDb(rpcImpl?: (...args: any[]) => Promise<any>) {
  const inserted: unknown[] = [];
  const db: any = {
    rpc: vi.fn(rpcImpl ?? (async () => ({ data: [] }))),
    from: vi.fn().mockReturnValue({
      insert: vi.fn(async (rows: unknown[]) => { inserted.push(...(rows as unknown[])); return { data: rows, error: null }; }),
    }),
    _inserted: inserted,
  };
  return db;
}

describe('runC4Checks', () => {
  it('空 issue 列表 = pass，diff=0，detail=null，写 qa_logs', async () => {
    const db = makeDb();
    const results = await runC4Checks({ db, runId: 'r1', trigger: 'cron' });
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r).toMatchObject({
      run_id: 'r1',
      trigger: 'cron',
      check_type: 'C4',
      check_name: C4_CHECK_NAME,
      status: 'pass',
      diff: 0,
      detail: null,
    });
    expect(db.from).toHaveBeenCalledWith('qa_logs');
    expect(db.from().insert).toHaveBeenCalledTimes(1);
    expect((db._inserted as any[])[0]).toMatchObject({ check_type: 'C4', check_name: C4_CHECK_NAME, status: 'pass' });
  });

  it('有 issue 列表 = fail，diff=issue 数，detail=issue 对象列表（to_jsonb 解包）', async () => {
    const db = makeDb(async () => ({
      data: [
        { to_jsonb: { issue: 'base 指标 m1 的 fact_table t1 未注册 datasets 且非 PG 表' } },
        { to_jsonb: { issue: 'derived 指标 m2 依赖未定义指标 m3' } },
      ],
    }));
    const results = await runC4Checks({ db, runId: 'r2', trigger: 'manual' });
    const r = results[0];
    expect(r.status).toBe('fail');
    expect(r.diff).toBe(2);
    expect(r.detail as any[]).toHaveLength(2);
    expect((r.detail as any[])[0]).toEqual({ issue: 'base 指标 m1 的 fact_table t1 未注册 datasets 且非 PG 表' });
    expect((r.detail as any[])[1]).toEqual({ issue: 'derived 指标 m2 依赖未定义指标 m3' });
  });

  it('处理裸对象行（PostgREST 未包 to_jsonb 形态）', async () => {
    const db = makeDb(async () => ({
      data: [{ issue: '维度 d1 的 join_key k1 不在表 t1' }],
    }));
    const results = await runC4Checks({ db, runId: 'r2b', trigger: 'cron' });
    expect(results[0].status).toBe('fail');
    expect(results[0].diff).toBe(1);
    expect((results[0].detail as any[])[0]).toEqual({ issue: '维度 d1 的 join_key k1 不在表 t1' });
  });

  it('execute_sql RPC 报错记 error，不静默 pass', async () => {
    const db = makeDb(async () => ({ error: { message: 'function validate_semantic_registry() does not exist' } }));
    const results = await runC4Checks({ db, runId: 'r3', trigger: 'cron' });
    const r = results[0];
    expect(r.status).toBe('error');
    expect(r.diff).toBeNull();
    expect((r.detail as any[])[0].error).toContain('does not exist');
  });

  it('RPC 调用包装为 to_jsonb 的 validate_semantic_registry 查询', async () => {
    const db = makeDb();
    await runC4Checks({ db, runId: 'r1', trigger: 'cron' });
    expect(db.rpc).toHaveBeenCalledWith('execute_sql', {
      query: 'SELECT to_jsonb(q) FROM (SELECT * FROM validate_semantic_registry()) AS q',
    });
  });

  it('checks 过滤：C4:semantic-registry 命中', async () => {
    const db = makeDb();
    const results = await runC4Checks({ db, runId: 'r4', trigger: 'manual', checks: ['C4:semantic-registry'] });
    expect(results).toHaveLength(1);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it('checks 过滤：bare C4 命中', async () => {
    const db = makeDb();
    const results = await runC4Checks({ db, runId: 'r5', trigger: 'manual', checks: ['C4'] });
    expect(results).toHaveLength(1);
  });

  it('checks 过滤：无关键跳过 C4，不调 RPC', async () => {
    const db = makeDb();
    const results = await runC4Checks({ db, runId: 'r6', trigger: 'manual', checks: ['D2:retail'] });
    expect(results).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('导出 C4_CHECK_NAME = semantic-registry', () => {
    expect(C4_CHECK_NAME).toBe('semantic-registry');
  });
});
