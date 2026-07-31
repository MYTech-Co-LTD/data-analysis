import { describe, it, expect, vi } from 'vitest';
import { explainSql } from '../explain.js';

describe('explainSql', () => {
  it('EXPLAIN 成功 → ok:true', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ 'QUERY PLAN': 'Seq Scan...' }] }),
    };
    const r = await explainSql(client as any, 'SELECT 1');
    expect(r.ok).toBe(true);
    expect(client.query).toHaveBeenCalledWith('EXPLAIN SELECT 1');
  });

  it('EXPLAIN 抛错 → ok:false 带 error', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('relation "nope" does not exist')),
    };
    const r = await explainSql(client as any, 'SELECT * FROM nope');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not exist');
  });
});
