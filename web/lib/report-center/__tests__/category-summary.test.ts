// web/lib/report-center/__tests__/category-summary.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// Task 2: 验证 getCategorySummary 返 GetterResult（ok / no-data / error 三态）。
// mock 链：getClient().database.from(...).select(...).eq(...) → { data, error }（无 order）
import { describe, it, expect, vi } from "vitest";
import { getCategorySummary } from "../category-summary";

vi.mock("@/lib/api", () => ({
  getClient: vi.fn(),
}));

vi.mock("@/lib/error", () => ({
  wrapError: (e: unknown) => ({
    type: "unknown",
    message: (e as { message?: string })?.message ?? "err",
    retry: true,
  }),
}));


function makeClient(data: unknown, error: unknown) {
  return {
    database: {
      from: () => ({
        select: () => ({
          eq: () => ({ data, error }),
        }),
      }),
    },
  };
}

describe("getCategorySummary", () => {
  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(null, { message: "boom", code: "PGRST123" })
    );
    const r = await getCategorySummary("1");
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });

  it("returns ok when rows present", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(
        [
          {
            target_id: 1,
            category: "水果",
            sale_target: 100,
            sale_actual: 120,
            sale_rate: 1.2,
            profit_target: 20,
            profit_actual: 25,
            profit_rate: 1.25,
            profit_margin: 0.2,
            daily_amount: 10,
            daily_profit: 2,
            daily_profit_margin: 0.2,
            remaining_daily_profit_target: 0,
          },
        ],
        null
      )
    );
    const r = await getCategorySummary("1");
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
  });
});
