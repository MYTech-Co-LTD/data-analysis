// web/lib/report-center/__tests__/region-breakdown.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// Task 2: 验证 getRegionBreakdown 返 GetterResult（ok / no-data / error 三态）。
// mock 链匹配真实代码：getClient().database.from(...).select(...).eq(...).order(...) → { data, error }
import { describe, it, expect, vi } from "vitest";
import { getRegionBreakdown } from "../region-breakdown";

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
          eq: () => ({
            order: () => ({ data, error }),
          }),
        }),
      }),
    },
  };
}

describe("getRegionBreakdown", () => {
  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(null, { message: "boom", code: "PGRST123" })
    );
    const r = await getRegionBreakdown("1");
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
            level: "region",
            region_code: "E",
            region_name: "东",
            sale_target: 100,
            sale_actual: 120,
            sale_rate: 1.2,
            delivery_target: 50,
            delivery_actual: 60,
            delivery_rate: 1.2,
            daily_sale: 10,
            daily_delivery: 5,
            remaining_daily_sale_target: 0,
            remaining_daily_delivery_target: 0,
            parent_code: null,
            sub_region_code: null,
            sub_region_name: null,
            branch_num: null,
            branch_name: null,
          },
        ],
        null
      )
    );
    const r = await getRegionBreakdown("1");
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
  });

  it("returns no-data when empty", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(makeClient([], null));
    const r = await getRegionBreakdown("1");
    expect(r.status).toBe("no-data");
  });
});
