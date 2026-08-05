// web/app/api/admin/reports/item-top/route.ts
// 商品日榜切换：单日销售/出库 TOP20（按 metric 排序）+ 全集合计（给合计行）。
// 走 RPC get_item_top_by_day（migration 145 后返 7 列含脱敏 sale_profit/outbound_profit）。
// 直接 getClient()：user-facing report，按调用方 cookie 的 JWT 走 authenticated RLS。
//
// 返回 TopBoard{ rows: TOP20, totalAmount, totalProfit }，前端合计行用 totals。
// Task 8 Critical: 复用 toBoard（已修脱敏：profit NULL 透传，全 null→totalProfit=null，
// 不再被 Number(null||0) 压成 0 误导无成本权限用户看到「¥0 合计」/「¥0 行毛利」）。
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";
import { toBoard } from "@/lib/report-center/item-breakdown";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, date, metric } = b ?? {}; // metric: 'sale' | 'outbound'
  if (!target_id || !date) {
    return NextResponse.json(
      { ok: false, error: "缺 target_id/date" },
      { status: 400 },
    );
  }
  const amtKey = metric === "sale" ? "sale_amount" : "outbound_amount";
  const profitKey = metric === "sale" ? "sale_profit" : "outbound_profit";

  const client = await getClient();
  const { data, error } = await client.database.rpc("get_item_top_by_day", {
    p_target_id: target_id,
    p_day: date,
  });
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 400 },
    );
  }

  // RPC 返 7 列：(item_code, item_name, category_name, sale_amount, sale_profit, outbound_amount, outbound_profit)
  // Task 8 Critical: 复用 toBoard 排序+TOP20+totals，杜绝 inline profit 累加与 toBoard 脱敏逻辑 drift。
  // toBoard 已处理脱敏：全 null→totalProfit=null 透传，部分 null→只累加非 null，row.profit=null 透传。
  const board = toBoard(
    (data ?? []) as Array<Record<string, unknown>>,
    amtKey,
    profitKey,
  );

  return NextResponse.json({
    ok: true,
    board,
  });
}
