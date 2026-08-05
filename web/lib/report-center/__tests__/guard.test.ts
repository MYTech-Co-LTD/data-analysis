// web/lib/report-center/__tests__/guard.test.ts
// F3 合计自洽 + F4 异常值 纯函数单测（spec 前端层 F3/F4）。
import { describe, it, expect } from "vitest";
import {
  isSuspiciousAmount,
  isSuspiciousProfit,
  isSuspiciousRate,
  isSuspiciousMargin,
  suspiciousClass,
  suspiciousTitle,
  amountsClose,
  ratesClose,
  numMatch,
  sumField,
  sumNullable,
  SUSPICIOUS_TOOLTIP,
} from "../guard";

describe("guard F4 anomaly detection", () => {
  it("isSuspiciousAmount: 负值/非数值可疑，0/null/正常值不标", () => {
    expect(isSuspiciousAmount(-1)).toBe(true);
    expect(isSuspiciousAmount(NaN)).toBe(true);
    expect(isSuspiciousAmount(Infinity)).toBe(true);
    expect(isSuspiciousAmount(0)).toBe(false);
    expect(isSuspiciousAmount(100)).toBe(false);
    expect(isSuspiciousAmount(null)).toBe(false);
    expect(isSuspiciousAmount(undefined)).toBe(false);
  });

  it("isSuspiciousProfit: 负利润=正常亏损不标；非数值才标", () => {
    expect(isSuspiciousProfit(-5)).toBe(false);
    expect(isSuspiciousProfit(NaN)).toBe(true);
    expect(isSuspiciousProfit(Infinity)).toBe(true);
    expect(isSuspiciousProfit(null)).toBe(false);
    expect(isSuspiciousProfit(10)).toBe(false);
  });

  it("isSuspiciousRate: <0 或 >1.5 或非数值可疑；==1.5 不算越界", () => {
    expect(isSuspiciousRate(-0.1)).toBe(true);
    expect(isSuspiciousRate(1.6)).toBe(true);
    expect(isSuspiciousRate(1.5)).toBe(false);
    expect(isSuspiciousRate(0.9)).toBe(false);
    expect(isSuspiciousRate(NaN)).toBe(true);
    expect(isSuspiciousRate(null)).toBe(false);
  });

  it("isSuspiciousMargin: >1.5 或 <-1 或非数值可疑；-0.5（-50%）亏损正常", () => {
    expect(isSuspiciousMargin(-0.5)).toBe(false);
    expect(isSuspiciousMargin(-1.01)).toBe(true);
    expect(isSuspiciousMargin(1.6)).toBe(true);
    expect(isSuspiciousMargin(0.12)).toBe(false);
    expect(isSuspiciousMargin(NaN)).toBe(true);
    expect(isSuspiciousMargin(null)).toBe(false);
  });

  it("suspiciousClass / suspiciousTitle", () => {
    expect(suspiciousClass(true, "text-slate-700")).toBe("text-red-600");
    expect(suspiciousClass(false, "text-slate-700")).toBe("text-slate-700");
    expect(suspiciousTitle(true)).toBe(SUSPICIOUS_TOOLTIP);
    expect(suspiciousTitle(false)).toBeUndefined();
  });
});

describe("guard F3 totals compare", () => {
  it("amountsClose 金额容差（默认 1 元）", () => {
    expect(amountsClose(100, 100)).toBe(true);
    expect(amountsClose(100, 100.5)).toBe(true);
    expect(amountsClose(100, 102)).toBe(false);
  });

  it("ratesClose 率容差（默认 1e-3，覆盖一次取整+浮点误差）", () => {
    expect(ratesClose(0.1234, 0.1234)).toBe(true);
    expect(ratesClose(0.1234, 0.1235)).toBe(true);
    expect(ratesClose(0.1234, 0.13)).toBe(false);
  });

  it("numMatch null 语义：同 null 匹配，一 null 一非不匹配", () => {
    expect(numMatch(null, null, 1, amountsClose)).toBe(true);
    expect(numMatch(10, null, 1, amountsClose)).toBe(false);
    expect(numMatch(null, 10, 1, amountsClose)).toBe(false);
    expect(numMatch(10, 10, 1, amountsClose)).toBe(true);
    expect(numMatch(10, 12, 1, amountsClose)).toBe(false);
  });

  it("sumField / sumNullable", () => {
    expect(sumField([{ v: 1 }, { v: 2 }, { v: 3 }], (r) => r.v)).toBe(6);
    const rows = [
      { v: 1 },
      { v: null },
      { v: 3 },
    ] as { v: number | null }[];
    expect(sumNullable(rows, (r) => r.v)).toBe(4);
    expect(sumNullable([{ v: null }], (r) => r.v)).toBeNull();
  });
});
