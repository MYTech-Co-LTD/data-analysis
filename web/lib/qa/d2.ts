// web/lib/qa/d2.ts
// D2 聚合表 PK 重复守护：经 RPC qa_d2_dup_rows(p_table, p_keys) 查 PK 分组 COUNT>1 行。
import type { DetailSource } from './types';

export interface D2DupRow {
  dup_key: string;
  cnt: number;
}

// db: postgrest 客户端（InsForge SDK），rpc 调用
export async function runD2(
  db: { rpc: (fn: string, body: Record<string, unknown>) => Promise<{ data?: unknown[]; error?: unknown } | unknown[]> },
  src: DetailSource,
): Promise<{ dupRows: D2DupRow[] }> {
  const res: any = await db.rpc('qa_d2_dup_rows', { p_table: src.agg_table, p_keys: src.agg_key });
  if (res && res.error) throw new Error('qa_d2_dup_rows: ' + JSON.stringify(res.error));
  const rows = Array.isArray(res) ? res : (res?.data ?? []);
  return { dupRows: (rows as D2DupRow[]) };
}
