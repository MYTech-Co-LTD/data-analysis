// health route 的纯函数：动态发现 audit 视图 + 计算 rollup 差异
// 抽出来便于单测（不依赖 PostgREST/网络）
//
// ⚠️ _audit 已废弃（迁移 155 删除 report_*_v_audit 等手写 drill 视图）。
// 下述 parseAuditViewNames/computeAuditStats 是旧 _audit 时代的契约，155 后生产返回空数组（空转）。
// rollup 自洽守护现由 C3 承担（web/lib/qa/c3-runner.ts 对 report_*_gen 的 level 列动态 pivot，
// 结果写 qa_logs）。health 面板的 rollup 段改用 computeRollupDiff（下方）喂 pivot 行。
// parseAuditViewNames/computeAuditStats 保留：向后兼容老调用方 + 单测不破坏。

// 从 PostgREST 根 OpenAPI 提取所有 report_*_v_audit 视图名
export function parseAuditViewNames(openapi: any): string[] {
  const fromDefs = openapi?.definitions ? Object.keys(openapi.definitions) : [];
  const fromPaths = openapi?.paths
    ? Object.keys(openapi.paths).map((p) => p.replace(/^\//, ''))
    : [];
  const names = new Set<string>([...fromDefs, ...fromPaths]);
  return [...names].filter((n) => /^report_.+_v_audit$/.test(n)).sort();
}

// 对一个 audit 视图的所有行：找 *_diff 列算 max(|值|)，*_total 列求和
export function computeAuditStats(rows: any[]): {
  diffColumns: { name: string; maxValue: number }[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
} {
  if (!Array.isArray(rows) || !rows.length) return { diffColumns: [], status: 'ok', totals: {} };
  const allKeys = Object.keys(rows[0]);
  const diffKeys = allKeys.filter((k) => k.endsWith('_diff'));
  const totalKeys = allKeys.filter((k) => k.endsWith('_total'));
  const diffColumns = diffKeys.map((name) => ({
    name,
    maxValue: Math.max(...rows.map((r) => Math.abs(Number(r[name]) || 0))),
  }));
  const totals: Record<string, number> = {};
  for (const tk of totalKeys) totals[tk] = rows.reduce((s, r) => s + (Number(r[tk]) || 0), 0);
  const status = diffColumns.every((d) => d.maxValue < 0.01) ? 'ok' : 'warn';
  return { diffColumns, status, totals };
}

/** C3 rollup pivot 行（buildRollupPivotSql(view, metric, false) 输出，每 target_id 一行） */
export interface RollupPivotRow {
  target_id: number | string;
  region_total: number | null;
  sub_region_total: number | null;
  store_total: number | null;
}

/** 从 C3 rollup pivot 行算健康统计：diffColumns(max |region-sub| / |region-store|) + totals + status。
 *  与 computeAuditStats 同契约（diffColumns 以 _diff 结尾，status ok 需全部 <0.01），
 *  health 面板可直接复用渲染。 */
export function computeRollupDiff(rows: RollupPivotRow[]): {
  diffColumns: { name: string; maxValue: number }[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
} {
  if (!Array.isArray(rows) || !rows.length) return { diffColumns: [], status: 'ok', totals: {} };
  const toNum = (v: number | null | undefined): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const diffs = rows.map((r) => ({
    region_vs_sub_region: Math.abs(toNum(r.region_total) - toNum(r.sub_region_total)),
    region_vs_store: Math.abs(toNum(r.region_total) - toNum(r.store_total)),
  }));
  const diffColumns = [
    { name: 'region_vs_sub_region_diff', maxValue: Math.max(...diffs.map((d) => d.region_vs_sub_region)) },
    { name: 'region_vs_store_diff', maxValue: Math.max(...diffs.map((d) => d.region_vs_store)) },
  ];
  const totals: Record<string, number> = {
    region_total: rows.reduce((s, r) => s + toNum(r.region_total), 0),
    sub_region_total: rows.reduce((s, r) => s + toNum(r.sub_region_total), 0),
    store_total: rows.reduce((s, r) => s + toNum(r.store_total), 0),
  };
  const status = diffColumns.every((d) => d.maxValue < 0.01) ? 'ok' : 'warn';
  return { diffColumns, status, totals };
}
