// web/app/api/admin/reports/item-list/route.ts
// 商品出库明细分页：翻页 + 类别/品牌/搜索筛选。
// 走 lib.getItemOutboundListPage（内部已 getClient()，按调用方 RLS）。
// lib 直查 report_item_breakdown_gen 视图，server 端按 outbound_amount 倒序，每页 50。
import { NextRequest, NextResponse } from "next/server";
import { getItemOutboundListPage } from "@/lib/report-center/item-breakdown";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, page, category, brand, q } = b ?? {};
  if (!target_id) {
    return NextResponse.json(
      { ok: false, error: "缺 target_id" },
      { status: 400 }
    );
  }
  const pageNum = Number(page) > 0 ? Number(page) : 1;
  try {
    const { rows, total } = await getItemOutboundListPage(Number(target_id), pageNum, {
      category,
      brand,
      q,
    });
    return NextResponse.json({ ok: true, rows, total });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
