// web/lib/report-center/guard.ts
// F3 合计自洽 + F4 异常值 检测纯函数（前端数据准确性守护，spec 前端层 F3/F4）。
// 只做判定（boolean / 容差比较），不渲染；组件层据此挂角标/标红/tooltip，不阻断渲染。

export const SUSPICIOUS_TOOLTIP = "数据可疑（负值/越界比率/非数值）";

// ---------- F4: 异常值检测 ----------

// 金额（收入/目标类）可疑：非数值(NaN/Infinity) 或 负值
export function isSuspiciousAmount(v: number | null | undefined): boolean {
  if (v == null) return false;
  return !Number.isFinite(v) || v < 0;
}

// 利润可疑：仅非数值。负利润 = 正常亏损（已有低毛利/负毛利标红），不标「可疑」。
export function isSuspiciousProfit(v: number | null | undefined): boolean {
  if (v == null) return false;
  return !Number.isFinite(v);
}

// 达成率/占比可疑：非数值 或 <0 或 >1.5（spec：比率>1.5 或 <0）
export function isSuspiciousRate(v: number | null | undefined): boolean {
  if (v == null) return false;
  return !Number.isFinite(v) || v < 0 || v > 1.5;
}

// 毛利率/配销比可疑：非数值 或 >1.5 或 <-1。
// 毛利率可负（亏损）——正常可到 -100%（=-1），-1 以下才视为数据异常。
export function isSuspiciousMargin(v: number | null | undefined): boolean {
  if (v == null) return false;
  return !Number.isFinite(v) || v < -1 || v > 1.5;
}

// 可疑单元格 className：覆盖原语义色为 text-red-600
export function suspiciousClass(suspicious: boolean, normalClass: string): string {
  return suspicious ? "text-red-600" : normalClass;
}

// 可疑单元格 title（原生 tooltip）：可疑时给「数据可疑」，否则无
export function suspiciousTitle(suspicious: boolean): string | undefined {
  return suspicious ? SUSPICIOUS_TOOLTIP : undefined;
}

// ---------- F3: 合计自洽校验 ----------

// 金额容差比较（SUM 浮点累加次序不同会有分差，默认 1 元容差）
export function amountsClose(a: number, b: number, tol = 1): boolean {
  return Math.abs(a - b) <= tol;
}

// 率容差比较（视图率 round 到 4 位小数，前端率由原始值算——相邻 4 位小数差 0.0001，
// 浮点表示会到 0.00010000000000000005，容差取 1e-3 覆盖一次取整 + 浮点误差）
export function ratesClose(a: number, b: number, tol = 1e-3): boolean {
  return Math.abs(a - b) <= tol;
}

// 两值匹配（nullable）：任一为 null 时须同为 null 才匹配；否则数值容差比较。
export function numMatch(
  a: number | null | undefined,
  b: number | null | undefined,
  tol: number,
  close: (x: number, y: number, tol: number) => boolean,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return close(a, b, tol);
}

// 对行数组按 pick 求和（null 忽略——调用方应先过滤/转 0）
export function sumField<T>(rows: T[], pick: (r: T) => number): number {
  let s = 0;
  for (const r of rows) s += pick(r);
  return s;
}

// 行数组求和但保留「是否有任何非 null」标志：全脱敏（null）时返 null 而非 0
export function sumNullable<T>(
  rows: T[],
  pick: (r: T) => number | null,
): number | null {
  let s = 0;
  let has = false;
  for (const r of rows) {
    const v = pick(r);
    if (v != null) {
      s += v;
      has = true;
    }
  }
  return has ? s : null;
}
