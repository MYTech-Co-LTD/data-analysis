// web/lib/report-center/item-breakdown.ts
// 商品 TOP 榜（销售/出库 × 月/日）+ 出库明细分页
// P2: 切换到语义层生成器产物 report_item_breakdown_gen（口径源自 metric_registry）
// 日榜走 RPC get_item_top_by_day（单日 item 级聚合，视图无单日维度）
import { getClient } from "@/lib/api";

export interface ItemTopRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  amount: number;
  pct: number; // 占比（0-1）
}

export interface ItemBreakdownTop {
  saleMonth: ItemTopRow[]; // 销售月榜 TOP20
  outboundMonth: ItemTopRow[]; // 出库月榜 TOP20
  saleDay: ItemTopRow[]; // 销售日榜 TOP20（默认日）
  outboundDay: ItemTopRow[]; // 出库日榜 TOP20（默认日）
  defaultDay: string; // 默认日期 YYYY-MM-DD
}

/**
 * 商品 TOP 榜（月榜从视图，日榜从 RPC）。
 * 月榜：sale_amount + outbound_amount（视图已按 target 周期聚合，前端只排序+TOP20）。
 * 日榜：调用 get_item_top_by_day(p_target_id, p_day) RPC，
 *   RPC 仅返回 (item_code, item_name, category_name, sale_amount, outbound_amount) 5 列，
 *   即日榜按 sale_amount 或 outbound_amount 排序。
 */
export async function getItemBreakdownTop(
  targetId: number
): Promise<ItemBreakdownTop> {
  const empty: ItemBreakdownTop = {
    saleMonth: [],
    outboundMonth: [],
    saleDay: [],
    outboundDay: [],
    defaultDay: "",
  };

  const client = await getClient();

  // 取目标周期，算默认日：今天在周期内→今天；今天>end→end；今天<start→start
  const { data: t, error: tErr } = await client.database
    .from("targets")
    .select("start_date,end_date")
    .eq("id", targetId)
    .single();
  if (tErr || !t) {
    console.error("getItemBreakdownTop: target fetch failed:", tErr);
    return empty;
  }
  const startDate: string = t.start_date;
  const endDate: string = t.end_date;
  const today = new Date().toISOString().slice(0, 10);
  const defaultDay =
    today >= startDate && today <= endDate
      ? today
      : today > endDate
      ? endDate
      : startDate;

  // 月榜全集（视图已按周期聚合，server 端排序 + TOP20）
  const { data: monthRows, error: mErr } = await client.database
    .from("report_item_breakdown_gen")
    .select("item_code,item_name,category_name,sale_amount,outbound_amount")
    .eq("target_id", targetId);
  if (mErr) {
    console.error("getItemBreakdownTop: month view fetch failed:", mErr);
    return { ...empty, defaultDay };
  }
  const monthArr = (monthRows ?? []) as Array<{
    item_code: string;
    item_name: string;
    category_name: string | null;
    sale_amount: number | string | null;
    outbound_amount: number | string | null;
  }>;
  const saleTotal = monthArr.reduce(
    (s, r) => s + Number(r.sale_amount || 0),
    0
  );
  const outTotal = monthArr.reduce(
    (s, r) => s + Number(r.outbound_amount || 0),
    0
  );

  // 通用 TOP 构造器：按 key 排序、TOP20、计算占比
  const toTop = (
    rows: Array<Record<string, unknown>>,
    key: string,
    total: number
  ): ItemTopRow[] =>
    rows
      .slice()
      .sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0))
      .slice(0, 20)
      .map((r) => ({
        item_code: String(r.item_code ?? ""),
        item_name: String(r.item_name ?? ""),
        category_name:
          r.category_name == null ? null : String(r.category_name),
        amount: Number(r[key] || 0),
        pct: total > 0 ? Number(r[key] || 0) / total : 0,
      }));

  const saleMonth = toTop(monthArr as unknown as Array<Record<string, unknown>>, "sale_amount", saleTotal);
  const outboundMonth = toTop(monthArr as unknown as Array<Record<string, unknown>>, "outbound_amount", outTotal);

  // 日榜：调 RPC（controller 在迁移 141 创建）
  // RPC 返回 5 列：(item_code, item_name, category_name, sale_amount, outbound_amount)
  const { data: dayRows, error: dErr } = await client.database.rpc(
    "get_item_top_by_day",
    { p_target_id: targetId, p_day: defaultDay }
  );
  if (dErr) {
    console.error("getItemBreakdownTop: day RPC failed:", dErr);
    return { saleMonth, outboundMonth, saleDay: [], outboundDay: [], defaultDay };
  }
  const dayArr = (dayRows ?? []) as Array<Record<string, unknown>>;
  const saleDayTotal = dayArr.reduce(
    (s, r) => s + Number(r.sale_amount || 0),
    0
  );
  const outDayTotal = dayArr.reduce(
    (s, r) => s + Number(r.outbound_amount || 0),
    0
  );
  const saleDay = toTop(dayArr, "sale_amount", saleDayTotal);
  const outboundDay = toTop(dayArr, "outbound_amount", outDayTotal);

  return { saleMonth, outboundMonth, saleDay, outboundDay, defaultDay };
}

export interface ItemOutboundListRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  top_category: string | null;
  delivery_amount: number;
  wholesale_amount: number;
  outbound_amount: number;
  pct: number; // 占比（前端可基于 total 重算，这里给 0 占位）
}

/**
 * 出库明细分页：按 outbound_amount 倒序，每页 50 行。
 * 占比留给前端基于完整 total 计算（避免 server 端二次全量查询）。
 */
export async function getItemOutboundListPage(
  targetId: number,
  page: number,
  filters: { category?: string; brand?: string; q?: string }
): Promise<{ rows: ItemOutboundListRow[]; total: number }> {
  const client = await getClient();
  let query = client.database
    .from("report_item_breakdown_gen")
    .select(
      "item_code,item_name,category_name,top_category,delivery_amount,wholesale_amount,outbound_amount",
      { count: "exact" }
    )
    .eq("target_id", targetId);
  if (filters.category) query = query.eq("top_category", filters.category);
  // 注：原 filters.brand → item_brand 筛选已移除（item_brand 是 manufacturer brand，脏值+跨品牌粒度，会导致 0 行）。
  if (filters.q) query = query.ilike("item_name", `%${filters.q}%`);

  const { data, count, error } = await query
    .order("outbound_amount", { ascending: false })
    .range((page - 1) * 50, page * 50 - 1);
  if (error) {
    console.error("getItemOutboundListPage: fetch failed:", error);
    return { rows: [], total: 0 };
  }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    top_category: r.top_category == null ? null : String(r.top_category),
    delivery_amount: Number(r.delivery_amount || 0),
    wholesale_amount: Number(r.wholesale_amount || 0),
    outbound_amount: Number(r.outbound_amount || 0),
    pct: 0,
  }));
  return { rows, total: count ?? 0 };
}
