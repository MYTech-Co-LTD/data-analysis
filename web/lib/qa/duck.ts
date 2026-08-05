// web/lib/qa/duck.ts
// DuckDB HTTP /query 执行器（照 scheduler duckdbParquetCount 模式）
// duckUrl = duckdb server（如 http://127.0.0.1:3730），apiKey = x-agent-key，POST { sql }，返 j.data，失败 throw。
// timeoutMs>0 时挂 AbortController：采集后 QA（executeTask 内）防某条查询永久挂起持锁；
// 默认 0=不设超时（daily cron 全量扫描保留原行为，重查询可能 >30s）。
export async function duckQuery(
  duckUrl: string,
  apiKey: string,
  sql: string,
  timeoutMs = 0,
): Promise<Record<string, unknown>[]> {
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetch(`${duckUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-key': apiKey },
      body: JSON.stringify({ sql }),
      ...(timeout ? { signal: controller.signal } : {}),
    });
    const j = await r.json();
    if (!j.success) throw new Error('duckdb: ' + j.error);
    return j.data;
  } catch (err: any) {
    if (timeout && err?.name === 'AbortError') {
      throw new Error(`duckdb query timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
