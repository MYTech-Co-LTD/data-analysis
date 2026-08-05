// web/lib/report-center/__tests__/wholesale-daily.test.ts
// Task 2: 验证 getWholesaleDaily / getWholesaleDailyCustomers 返 GetterResult（ok / no-data / error 三态）。
// getWholesaleDaily mock 链：from().select().eq().order() → { data, error }
// getWholesaleDailyCustomers mock 链：from().select().eq().eq().order() → { data, error }
import { describe, it, expect, vi } from "vitest";
import {
  getWholesaleDaily,
  getWholesaleDailyCustomers,
} from "../wholesale-daily";

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

vi.mock("../target-snapshot", () => ({
  getSnapshotRows: vi.fn(),
}));

describe("getWholesaleDaily", () => {
  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                data: null,
                error: { message: "boom", code: "PGRST123" },
              }),
            }),
          }),
        }),
      },
    });
    const r = await getWholesaleDaily(1);
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });

  it("returns ok when rows present", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                data: [
                  {
                    target_id: 1,
                    biz_date: "2026-08-01",
                    wholesale_ext_amount: 1000,
                    wholesale_ext_profit: 200,
                    wholesale_ext_margin: 0.2,
                  },
                ],
                error: null,
              }),
            }),
          }),
        }),
      },
    });
    const r = await getWholesaleDaily(1);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
  });
});

describe("getWholesaleDailyCustomers", () => {
  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  data: null,
                  error: { message: "boom", code: "PGRST123" },
                }),
              }),
            }),
          }),
        }),
      },
    });
    const r = await getWholesaleDailyCustomers(1, "2026-08-01");
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });
});
