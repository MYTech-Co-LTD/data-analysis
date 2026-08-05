// web/lib/report-center/__tests__/item-breakdown.test.ts
// Task 2: 验证 getItemBreakdownTop 返 ItemBreakdownResult（status: ok | error）。
// 最短路径触发 error：targets 表 single() 返 error → 第一个 error 分支（行 ~80）。
// mock 链：client.database.from("targets").select(...).eq(...).single() → { data, error }
import { describe, it, expect, vi } from "vitest";
import { getItemBreakdownTop, toBoard } from "../item-breakdown";

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

describe("getItemBreakdownTop", () => {
  it("returns status=error on target fetch failure (not bare empty)", async () => {
    const { getClient } = await import("@/lib/api");
    // targets 表 single() 返 error → 第一个 error 分支
    (getClient as any).mockResolvedValue({
      database: {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: () => ({
                data: null,
                error: { message: "target fetch boom", code: "PGRST123" },
              }),
            }),
          }),
        }),
      },
    });
    const r = await getItemBreakdownTop(1);
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    // 数据形状仍是 4 个 board（兼容 dashboard 组件 ItemBreakdownTop 契约）
    expect(r.saleMonth.rows).toEqual([]);
    expect(r.saleDay.rows).toEqual([]);
    expect(r.outboundMonth.rows).toEqual([]);
    expect(r.outboundDay.rows).toEqual([]);
    expect(r.defaultDay).toBe("");
  });

  it("returns status=ok end-to-end (target + month view + day RPC)", async () => {
    const { getClient } = await import("@/lib/api");
    // 链路：
    //   1) from("targets").select().eq().single() → target
    //   2) from("report_item_breakdown_gen").select().eq() → monthRows（active 路径）
    //   3) .rpc("get_item_top_by_day", ...) → dayRows
    const target = { start_date: "2026-08-01", end_date: "2026-08-31" };
    const monthRows = [
      {
        item_code: "A",
        item_name: "Apple",
        category_name: "水果",
        sale_amount: 100,
        sale_profit: 20,
        outbound_amount: 50,
        outbound_profit: 10,
      },
    ];
    const dayRows = [
      {
        item_code: "A",
        item_name: "Apple",
        category_name: "水果",
        sale_amount: 10,
        sale_profit: 2,
        outbound_amount: 5,
        outbound_profit: 1,
      },
    ];

    const fromMock = (table: string) => {
      if (table === "targets") {
        return {
          select: () => ({
            eq: () => ({ single: () => ({ data: target, error: null }) }),
          }),
        };
      }
      // report_item_breakdown_gen
      return {
        select: () => ({
          eq: () => ({ data: monthRows, error: null }),
        }),
      };
    };
    (getClient as any).mockResolvedValue({
      database: {
        from: fromMock,
        rpc: () => ({ data: dayRows, error: null }),
      },
    });
    const r = await getItemBreakdownTop(1);
    expect(r.status).toBe("ok");
    expect(r.saleMonth.rows).toHaveLength(1);
    expect(r.saleMonth.rows[0].item_code).toBe("A");
    expect(r.saleDay.rows[0].item_code).toBe("A");
    expect(r.outboundMonth.totalAmount).toBe(50);
    expect(r.defaultDay).toBeTruthy();
  });
});

// Task 8 (F2.4): toBoard 脱敏利润不再被压成 0
describe("toBoard masked profit", () => {
  it("totalProfit is null when all profit values are null (masked)", () => {
    const rows = [
      { item_code: "1", item_name: "A", category_name: null, amount: 100, profit: null },
      { item_code: "2", item_name: "B", category_name: null, amount: 50, profit: null },
    ] as Array<Record<string, unknown>>;
    const board = toBoard(rows, "amount", "profit");
    expect(board.totalAmount).toBe(150);
    expect(board.totalProfit).toBeNull(); // 不再被 Number(null||0) 压成 0
    // 单行 profit 也透传 null（不是 0）
    expect(board.rows[0].profit).toBeNull();
    expect(board.rows[1].profit).toBeNull();
  });

  it("totalProfit sums normally when profit values present", () => {
    const rows = [
      { item_code: "1", item_name: "A", category_name: null, amount: 100, profit: 10 },
      { item_code: "2", item_name: "B", category_name: null, amount: 50, profit: 5 },
    ] as Array<Record<string, unknown>>;
    const board = toBoard(rows, "amount", "profit");
    expect(board.totalAmount).toBe(150);
    expect(board.totalProfit).toBe(15);
    expect(board.rows[0].profit).toBe(10);
  });

  it("totalProfit sums non-null profits even if some rows masked (partial mask)", () => {
    // 部分行脱敏：只累加可见的利润行，不被 NULL 拖成 0
    const rows = [
      { item_code: "1", item_name: "A", category_name: null, amount: 100, profit: 10 },
      { item_code: "2", item_name: "B", category_name: null, amount: 50, profit: null },
    ] as Array<Record<string, unknown>>;
    const board = toBoard(rows, "amount", "profit");
    expect(board.totalProfit).toBe(10); // 只加非 null 的 10，不当 null 做 0
    expect(board.rows[0].profit).toBe(10);
    expect(board.rows[1].profit).toBeNull();
  });
});
