// web/app/api/admin/reports/wholesale-day-customers/route.ts
// 外部批发日报下钻：按 biz_date 取该天客户明细（每行=该天该客户）。
// 走视图 report_wholesale_daily_customer_gen（双 grain：dim_code='customer' + extra_grain biz_date）。
// 直接 getClient()：user-facing report，按调用方 cookie 的 JWT 走 authenticated RLS + can_see_cost 脱敏。
//
// POST { target_id, date } -> { ok: true, rows: WholesaleDailyCustomerRow[] }
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, date } = b ?? {};
  if (!target_id || !date) {
    return NextResponse.json(
      { ok: false, error: "缺 target_id/date" },
      { status: 400 },
    );
  }

  const client = await getClient();
  const { data, error } = await client.database
    .from("report_wholesale_daily_customer_gen")
    .select(
      "client_code,client_name,wholesale_ext_customer_amount,wholesale_ext_customer_profit,wholesale_ext_customer_margin",
    )
    .eq("target_id", target_id)
    .eq("biz_date", date)
    .order("wholesale_ext_customer_amount", { ascending: false });

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 400 },
    );
  }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    client_code: String(r.client_code ?? ""),
    client_name: String(r.client_name ?? ""),
    wholesale_ext_customer_amount: Number(r.wholesale_ext_customer_amount ?? 0),
    wholesale_ext_customer_profit:
      r.wholesale_ext_customer_profit == null
        ? null
        : Number(r.wholesale_ext_customer_profit),
    wholesale_ext_customer_margin:
      r.wholesale_ext_customer_margin == null
        ? null
        : Number(r.wholesale_ext_customer_margin),
  }));

  return NextResponse.json({ ok: true, rows });
}
