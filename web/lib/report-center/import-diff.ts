// Excel 导入 diff：对比当前 branchRows 与导入 rows，返回有变更的格。
// 按 rowKey（branch_number 优先；回退 system_book_code-branch_num；再回退 branch_num）+ metric 对比；
// 当前不存在的门店视为 0（新增）。
// 注：branch_num 在两品牌(3120=熊喵 / 64188=品品甜)间共享(128 个)，不能单独作主键。

export interface TargetMetricRow {
  branch_number?: string;       // 全局唯一门店键（sbc-branch_num）
  branch_num: string;
  system_book_code?: string;    // 账套(品牌)码
  branch_name?: string;
  metrics: Record<string, number>;
}

export interface DiffEntry {
  branch_num: string;           // 仅展示用
  branch_name?: string;
  metric: string;
  oldValue: number;
  newValue: number;
  diff: number;
}

// 门店行主键：优先 branch_number；回退 system_book_code-branch_num；再回退 -branch_num
// （最后回退仅用于导入源未带 sbc 的退化场景，此时共享 branch_num 仍会歧义，已知限制）
// 注意：必须用 if/if/return 显式判定——`r.branch_number || \`${r.system_book_code}-${r.branch_num}\``
// 在 branch_number 与 system_book_code 同时缺失时会得到字面量 "undefined-048"（truthy），
// 使最后回退分支永不命中。导出供 page.tsx 与 diffImport 共享同一份规则。
export function rowKey(r: TargetMetricRow): string {
  if (r.branch_number) return r.branch_number;
  if (r.system_book_code) return `${r.system_book_code}-${r.branch_num}`;
  return `-${r.branch_num}`;
}

export function diffImport(
  current: TargetMetricRow[],
  incoming: TargetMetricRow[],
  metrics: string[] = ['sale', 'delivery'],
): DiffEntry[] {
  const curMap = new Map(current.map(r => [rowKey(r), r]));
  const diffs: DiffEntry[] = [];
  for (const inc of incoming) {
    const cur = curMap.get(rowKey(inc));
    for (const m of metrics) {
      const oldVal = Number(cur?.metrics?.[m]) || 0;
      const newVal = Number(inc.metrics?.[m]) || 0;
      if (oldVal !== newVal) {
        diffs.push({
          branch_num: inc.branch_num,
          branch_name: inc.branch_name ?? cur?.branch_name,
          metric: m,
          oldValue: oldVal,
          newValue: newVal,
          diff: newVal - oldVal,
        });
      }
    }
  }
  return diffs;
}
