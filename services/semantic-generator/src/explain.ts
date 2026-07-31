import type { PoolClient } from 'pg';

export interface ExplainResult {
  ok: boolean;
  error?: string;
}

export async function explainSql(client: PoolClient, sql: string): Promise<ExplainResult> {
  try {
    await client.query(`EXPLAIN ${sql}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
