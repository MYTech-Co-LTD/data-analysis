// web/app/api/admin/reports/item-detail/route.ts
// 弹层（item_code 详情）：日 × 品牌分布（销售+出库）+ dim_item 元信息。
//   - get_item_detail RPC（migration 142，controller 部署）：按 target 周期返回
//     (biz_date, system_book_code, sale_amount, outbound_amount)，供前端日趋势/品牌分布。
//   - dim_item 按 item_code 查（item_code 是跨品牌合并键，可能多行，limit 1 取代表行）。
// 直接 getClient()：user-facing report，按调用方 cookie 的 JWT 走 authenticated RLS。
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, item_code } = b ?? {};
  if (!target_id || !item_code) {
    return NextResponse.json(
      { ok: false, error: "缺 target_id/item_code" },
      { status: 400 }
    );
  }
  const code = String(item_code);
  const client = await getClient();

  // 日 × 品牌趋势：该 item_code 所有 item_num 跨品牌按日聚合
  const { data: daily, error: e1 } = await client.database.rpc("get_item_detail", {
    p_target_id: target_id,
    p_item_code: code,
  });
  if (e1) {
    return NextResponse.json({ ok: false, error: e1.message }, { status: 400 });
  }

  // 商品元信息：item_name / 类别归属 / 品牌
  const { data: meta, error: e2 } = await client.database
    .from("dim_item")
    .select("item_name,category_name,top_category,item_brand,system_book_code")
    .eq("item_code", code)
    .limit(1);
  if (e2) {
    return NextResponse.json({ ok: false, error: e2.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, daily: daily ?? [], meta: meta ?? [] });
}
