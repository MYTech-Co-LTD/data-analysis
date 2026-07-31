// L3b 双轨对账：比旧手写视图 vs 新生成视图各列 SUM
export interface ColDiff {
  col: string;
  oldSum: number;
  newSum: number;
  diff: number;
}

function sumCol(rows: Record<string, unknown>[], col: string): number {
  return rows.reduce((acc, r) => acc + Number(r[col] ?? 0), 0);
}

export function sumDiff(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  cols: string[],
): ColDiff[] {
  return cols.map((col) => {
    const oldSum = sumCol(oldRows, col);
    const newSum = sumCol(newRows, col);
    return { col, oldSum, newSum, diff: Math.round((oldSum - newSum) * 100) / 100 };
  });
}
