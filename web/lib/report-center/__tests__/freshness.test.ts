// web/lib/report-center/__tests__/freshness.test.ts
// F5 时效陈旧门 纯函数单测（spec 前端层 F5）。
import { describe, it, expect } from "vitest";
import {
  formatFreshnessChina,
  staleHoursSince,
  isFreshnessStale,
  FRESHNESS_STALE_HOURS,
} from "../freshness";

describe("freshness F5", () => {
  it("FRESHNESS_STALE_HOURS = 6", () => {
    expect(FRESHNESS_STALE_HOURS).toBe(6);
  });

  it("formatFreshnessChina: 空/无效 → null", () => {
    expect(formatFreshnessChina(null)).toBeNull();
    expect(formatFreshnessChina(undefined)).toBeNull();
    expect(formatFreshnessChina("")).toBeNull();
  });

  it("formatFreshnessChina: ISO UTC → Asia/Shanghai YYYY-MM-DD HH:MM", () => {
    // 2026-08-05T06:30:00Z = 北京时间 14:30
    expect(formatFreshnessChina("2026-08-05T06:30:00Z")).toBe(
      "2026-08-05 14:30",
    );
  });

  it("staleHoursSince: null/无效 → null", () => {
    expect(staleHoursSince(null, 0)).toBeNull();
    expect(staleHoursSince("not-a-date", 0)).toBeNull();
  });

  it("staleHoursSince: 距今小时（向下取整）", () => {
    const now = new Date("2026-08-05T12:00:00Z").getTime();
    expect(staleHoursSince("2026-08-05T05:00:00Z", now)).toBe(7);
    expect(staleHoursSince("2026-08-05T06:00:00Z", now)).toBe(6);
    expect(staleHoursSince("2026-08-05T11:30:00Z", now)).toBe(0);
  });

  it("isFreshnessStale: 距今 >6h 才 stale（6h 整不算）", () => {
    const now = new Date("2026-08-05T12:00:00Z").getTime();
    expect(isFreshnessStale("2026-08-05T05:00:00Z", now)).toBe(true); // 7h
    expect(isFreshnessStale("2026-08-05T06:00:00Z", now)).toBe(false); // 6h 整
    expect(isFreshnessStale("2026-08-05T10:00:00Z", now)).toBe(false);
    expect(isFreshnessStale(null, now)).toBe(false);
  });
});
