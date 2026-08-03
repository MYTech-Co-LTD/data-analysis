// web/lib/qa/d1.ts
// D1 明细主键唯一性守护：COUNT(*) vs COUNT(DISTINCT 自然键)
// 抓 transform 去重失败（明细翻倍）——C1 明细↔聚合对账对"双端同翻"是盲的，必须 D1 独立。
import type { DetailSource } from './types';
import { duckQuery } from './duck';

// 把 glob 的日期段（品牌段后的下一个段，all.parquet 前）替换为具体日期目录，
// 使采集后 D1 只扫当日分区，避免每次采集全量重扫整库（DuckDB 无法按派生日期剪枝普通 glob）。
// retail 日期目录 = YYYY-MM-DD（iso），delivery/wholesale = YYYYMMDD（compact）。
export function buildDayGlob(src: DetailSource, dayCompact: string): string {
  const daySeg = src.glob_date_format === 'iso'
    ? `${dayCompact.slice(0, 4)}-${dayCompact.slice(4, 6)}-${dayCompact.slice(6, 8)}`
    : dayCompact;
  // 替换 all.parquet 前的最后一个段（兼容 * 、*-*-* 或具体日期）
  return src.glob.replace(/[^/]+\/all\.parquet$/, `${daySeg}/all.parquet`);
}

export function buildD1Sql(src: DetailSource, dateFrom: string, dateTo: string, globOverride?: string): string {
  const keyExpr = src.natural_key.map((k) => `CAST(${k} AS VARCHAR)`).join(", '\\x1F', ");
  return `SELECT ${src.brand_expr} AS system_book_code,
  ${src.detail_date_expr} AS bizday,
  COUNT(*) AS total_rows,
  COUNT(DISTINCT CONCAT_WS('\\x1F', ${keyExpr})) AS distinct_rows
FROM read_parquet('${globOverride ?? src.glob}', filename=true)
WHERE ${src.detail_date_expr} BETWEEN '${dateFrom}' AND '${dateTo}'
GROUP BY 1, 2
HAVING COUNT(*) > COUNT(DISTINCT CONCAT_WS('\\x1F', ${keyExpr}))`;
}

export interface D1DupRow {
  system_book_code: string;
  bizday: string;
  total_rows: number;
  distinct_rows: number;
}

export async function runD1(
  duck: (sql: string) => Promise<Record<string, unknown>[]>,
  src: DetailSource,
  dateFrom: string,
  dateTo: string,
  globOverride?: string,
): Promise<{ dupRows: D1DupRow[]; query: string }> {
  const query = buildD1Sql(src, dateFrom, dateTo, globOverride);
  const rows = (await duck(query)) as unknown as D1DupRow[];
  return { dupRows: rows, query };
}

export { duckQuery };
