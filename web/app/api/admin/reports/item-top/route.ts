// web/app/api/admin/reports/item-top/route.ts
// 商品日榜切换：单日销售/出库 TOP20（按 metric 排序）+ 全集合计（给合计行）。
// 走 RPC get_item_top_by_day（migration 145 后返 7 列含脱敏 sale_profit/outbound_profit）。
// 直接 getClient()：user-facing report，按调用方 cookie 的 JWT 走 authenticated RLS。
//
// 返回 TopBoard{ rows: TOP20, totalAmount, totalProfit }，前端合计行用 totals。
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";

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
  const all = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    amount: Number(r[amtKey] ?? 0),
    profit: Number(r[profitKey] ?? 0),
  }));
  const totalAmount = all.reduce((s, r) => s + r.amount, 0);
  const totalProfit = all.reduce((s, r) => s + r.profit, 0);
  all.sort((a, b) => b.amount - a.amount);
  const rows = all.slice(0, 20).map((r) => ({
    item_code: r.item_code,
    item_name: r.item_name,
    category_name: r.category_name,
    amount: r.amount,
    profit: r.profit,
    pct: totalAmount > 0 ? r.amount / totalAmount : 0,
  }));

  return NextResponse.json({
    ok: true,
    board: { rows, totalAmount, totalProfit },
  });
}
