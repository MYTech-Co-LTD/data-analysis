// web/lib/report-center/__tests__/supply-chain-outbound.test.ts
// Task 2: 验证 getSupplyChainOutbound 返 GetterResult（ok / no-data / error 三态）。
// mock 链：getClient().database.from(...).select(...).eq(...) → { data, error }（无 order）
import { describe, it, expect, vi } from "vitest";
import { getSupplyChainOutbound } from "../supply-chain-outbound";

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

describe("getSupplyChainOutbound", () => {
  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(null, { message: "boom", code: "PGRST123" })
    );
    const r = await getSupplyChainOutbound(1);
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
            parent_code: null,
            region_code: "东",
            region_name: "东",
            sub_region_code: null,
            sub_region_name: null,
            branch_num: null,
            branch_name: null,
            war_zone: null,
            region_l2: null,
            delivery_amount: 100,
            delivery_profit: 20,
            delivery_margin: 0.2,
            daily_delivery_amount: 10,
            daily_delivery_profit: 2,
            daily_delivery_margin: 0.2,
          },
        ],
        null
      )
    );
    const r = await getSupplyChainOutbound(1);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
  });
});
