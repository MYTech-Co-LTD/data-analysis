// web/app/api/admin/reports/item-top/__tests__/route.test.ts
// Task 8 Critical: 日榜切换 API 复用 toBoard 后，脱敏 profit（NULL）不再被 Number(null||0)
// 压成 0。验证无成本权限用户切日时仍拿到 board.totalProfit === null（不当误导性的 0）。
//
// mock 链：getClient().database.rpc("get_item_top_by_day", ...) → { data, error }
// data 行的 sale_profit/outbound_profit 模拟脱敏（null）。
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

vi.mock("@/lib/api", () => ({
  getClient: vi.fn(),
}));

function mkReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/reports/item-top", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/reports/item-top — toBoard 脱敏 profit 复用", () => {
  it("totalProfit === null when all sale_profit masked (sale metric)", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        rpc: () => ({
          data: [
            { item_code: "A", item_name: "Apple", category_name: "水果", sale_amount: 100, sale_profit: null, outbound_amount: 50, outbound_profit: null },
            { item_code: "B", item_name: "Banana", category_name: "水果", sale_amount: 80, sale_profit: null, outbound_amount: 40, outbound_profit: null },
          ],
          error: null,
        }),
      },
    });
    const res = await POST(mkReq({ target_id: 1, date: "2026-08-04", metric: "sale" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    // 关键断言：全脱敏 → null（不当 0 累加）
    expect(body.board.totalProfit).toBeNull();
    expect(body.board.rows[0].profit).toBeNull();
    // amount 仍正常累加
    expect(body.board.totalAmount).toBe(180);
  });

  it("totalProfit === null when all outbound_profit masked (outbound metric)", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        rpc: () => ({
          data: [
            { item_code: "A", item_name: "Apple", category_name: "水果", sale_amount: 100, sale_profit: 10, outbound_amount: 50, outbound_profit: null },
            { item_code: "B", item_name: "Banana", category_name: "水果", sale_amount: 80, sale_profit: 8, outbound_amount: 40, outbound_profit: null },
          ],
          error: null,
        }),
      },
    });
    const res = await POST(mkReq({ target_id: 1, date: "2026-08-04", metric: "outbound" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    // outbound 口径全脱敏 → null
    expect(body.board.totalProfit).toBeNull();
    expect(body.board.rows[0].profit).toBeNull();
    expect(body.board.totalAmount).toBe(90);
  });

  it("totalProfit sums normally when profit values present (sale metric)", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        rpc: () => ({
          data: [
            { item_code: "A", item_name: "Apple", category_name: "水果", sale_amount: 100, sale_profit: 10, outbound_amount: 50, outbound_profit: 5 },
            { item_code: "B", item_name: "Banana", category_name: "水果", sale_amount: 80, sale_profit: 8, outbound_amount: 40, outbound_profit: 4 },
          ],
          error: null,
        }),
      },
    });
    const res = await POST(mkReq({ target_id: 1, date: "2026-08-04", metric: "sale" }));
    const body = await res.json();
    expect(body.board.totalProfit).toBe(18);
    expect(body.board.rows[0].profit).toBe(10);
  });

  it("returns 400 when target_id or date missing", async () => {
    const res = await POST(mkReq({ date: "2026-08-04" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("returns 400 when RPC errors", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue({
      database: {
        rpc: () => ({ data: null, error: { message: "rpc boom" } }),
      },
    });
    const res = await POST(mkReq({ target_id: 1, date: "2026-08-04", metric: "sale" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rpc boom");
  });
});
