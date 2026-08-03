// web/lib/qa/duck.ts
// DuckDB HTTP /query 执行器（照 scheduler duckdbParquetCount 模式）
// duckUrl = duckdb server（如 http://127.0.0.1:3730），apiKey = x-agent-key，POST { sql }，返 j.data，失败 throw。
export async function duckQuery(
  duckUrl: string,
  apiKey: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${duckUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': apiKey },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('duckdb: ' + j.error);
  return j.data;
}
