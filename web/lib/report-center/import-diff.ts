// Excel 导入 diff：对比当前 branchRows 与导入 rows，返回有变更的格。
// 按 branch_num + metric 对比；当前不存在的门店视为 0（新增）。

export interface TargetMetricRow {
  branch_num: string;
  branch_name?: string;
  metrics: Record<string, number>;
}

export interface DiffEntry {
  branch_num: string;
  branch_name?: string;
  metric: string;
  oldValue: number;
  newValue: number;
  diff: number;
}

export function diffImport(
  current: TargetMetricRow[],
  incoming: TargetMetricRow[],
  metrics: string[] = ['sale', 'delivery'],
): DiffEntry[] {
  const curMap = new Map(current.map(r => [r.branch_num, r]));
  const diffs: DiffEntry[] = [];
  for (const inc of incoming) {
    const cur = curMap.get(inc.branch_num);
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
