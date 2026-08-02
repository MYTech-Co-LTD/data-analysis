// web/app/api/admin/reports/item-top/route.ts
// 商品日榜切换：单日销售/出库 TOP20（按 metric 排序）。
// 走 RPC get_item_top_by_day（视图不带单日维度，单日 item 级聚合只能在 RPC）。
// 直接 getClient()：user-facing report，按调用方 cookie 的 JWT 走 authenticated RLS。
//
// 注：get_item_top_by_day 是 DB RPC（migration 141），不是 lib 函数。
//     月榜走 report_item_breakdown_gen 视图，前端组件直查 lib.getItemBreakdownTop；
//     此路由只为「日榜日期切换」按需 fetch。
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, date, metric } = b ?? {}; // metric: 'sale' | 'outbound'
  if (!target_id || !date) {
    return NextResponse.json(
      { ok: false, error: "缺 target_id/date" },
      { status: 400 }
    );
  }
  const amtKey = metric === "sale" ? "sale_amount" : "outbound_amount";

  const client = await getClient();
  const { data, error } = await client.database.rpc("get_item_top_by_day", {
    p_target_id: target_id,
    p_day: date,
  });
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 400 }
    );
  }

  // RPC 返回 5 列：(item_code, item_name, category_name, sale_amount, outbound_amount)
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    amount: Number(r[amtKey] ?? 0),
  }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  rows.sort((a, b) => b.amount - a.amount);
  const top20 = rows.slice(0, 20).map((r) => ({
    item_code: r.item_code,
    item_name: r.item_name,
    category_name: r.category_name,
    amount: r.amount,
    pct: total > 0 ? r.amount / total : 0,
  }));

  return NextResponse.json({ ok: true, rows: top20 });
}
