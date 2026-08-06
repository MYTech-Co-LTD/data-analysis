// web/lib/report-center/__tests__/freshness.test.ts
// F5 时效陈旧门 纯函数单测（spec 前端层 F5）。
// 两时间模型：get_data_freshness 返回 { data_updated_at, last_query_at }。
//   - data_updated_at 数据新旧，仅展示
//   - last_query_at 系统活跃心跳，陈旧告警据此（null 从未运行不告警）
import { describe, it, expect } from "vitest";
import {
  formatFreshnessChina,
  staleHoursSince,
  isFreshnessStale,
  staleBannerText,
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

  it("两时间格式化：data_updated_at 与 last_query_at 都按上海时间展示", () => {
    // 数据旧（源头没数据）+ 系统在跑（最近查询新）
    const fr = {
      data_updated_at: "2026-08-06T01:30:00Z", // 北京 09:30
      last_query_at: "2026-08-06T02:00:00Z", // 北京 10:00
    };
    expect(formatFreshnessChina(fr.data_updated_at)).toBe("2026-08-06 09:30");
    expect(formatFreshnessChina(fr.last_query_at)).toBe("2026-08-06 10:00");
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

  it("staleBannerText: last_query_at 距今 >6h → 告警文案（基于系统活跃）", () => {
    const now = new Date("2026-08-05T12:00:00Z").getTime();
    // 7h → 红色横幅文案，含系统最近查询时间（上海 2026-08-05 13:00）与小时数
    expect(staleBannerText("2026-08-05T05:00:00Z", now)).toBe(
      "系统最近查询停留在 2026-08-05 13:00，已超 7 小时未运行",
    );
  });

  it("staleBannerText: 6h 整 / 活跃 → null（不告警）", () => {
    const now = new Date("2026-08-05T12:00:00Z").getTime();
    expect(staleBannerText("2026-08-05T06:00:00Z", now)).toBeNull(); // 6h 整
    expect(staleBannerText("2026-08-05T11:00:00Z", now)).toBeNull(); // 1h
    expect(staleBannerText("2026-08-05T12:00:00Z", now)).toBeNull(); // 0h
  });

  it("staleBannerText: last_query_at null（从未运行）/ 无效 → null（不告警）", () => {
    expect(staleBannerText(null, Date.now())).toBeNull();
    expect(staleBannerText(undefined, Date.now())).toBeNull();
    expect(staleBannerText("not-a-date", Date.now())).toBeNull();
  });

  it("staleBannerText: 数据旧但系统在跑 → 不告警（源头没数据≠系统停）", () => {
    const now = new Date("2026-08-06T02:00:00Z").getTime();
    // data_updated_at 旧（源头没数据），但 last_query_at 新（系统心跳活跃）→ 不告警
    const data_updated_at = "2026-08-06T01:30:00Z"; // 30 分钟前，数据旧
    const last_query_at = "2026-08-06T01:59:00Z"; // 1 分钟前，系统在跑
    expect(isFreshnessStale(data_updated_at, now)).toBe(false);
    expect(staleBannerText(last_query_at, now)).toBeNull();
  });
});
