// web/lib/report-center/item-breakdown.ts
// 商品 TOP 4 独立看板（月度销售/日销售/月度出库/日出库）+ 出库明细分页
// 月榜走视图 report_item_breakdown_gen（含脱敏 sale_profit/outbound_profit）；
// 日榜走 RPC get_item_top_by_day（migration 145 后返 7 列含脱敏利润）。
import { getClient } from "@/lib/api";
import { getSnapshotRows } from "./target-snapshot";

export interface ItemTopRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  amount: number;
  profit: number; // 销售毛利/出库毛利（脱敏，无成本权限为 NULL->0）
  pct: number; // 占总金额比（0-1）
}

export interface TopBoard {
  rows: ItemTopRow[]; // TOP20
  totalAmount: number; // 全集合计金额（给合计行「总合计」用）
  totalProfit: number; // 全集合计毛利
}

export interface ItemBreakdownTop {
  saleMonth: TopBoard;
  saleDay: TopBoard;
  outboundMonth: TopBoard;
  outboundDay: TopBoard;
  defaultDay: string; // 默认日期 YYYY-MM-DD
}

// 通用 TopBoard 构造器：按 amtKey 排序 + TOP20 + 利润 + totals（给合计行）
function toBoard(
  rows: Array<Record<string, unknown>>,
  amtKey: string,
  profitKey: string,
): TopBoard {
  const totalAmount = rows.reduce((s, r) => s + Number(r[amtKey] || 0), 0);
  const totalProfit = rows.reduce((s, r) => s + Number(r[profitKey] || 0), 0);
  const sorted = rows
    .slice()
    .sort((a, b) => Number(b[amtKey] || 0) - Number(a[amtKey] || 0));
  const top: ItemTopRow[] = sorted.slice(0, 20).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    amount: Number(r[amtKey] || 0),
    profit: Number(r[profitKey] || 0),
    pct: totalAmount > 0 ? Number(r[amtKey] || 0) / totalAmount : 0,
  }));
  return { rows: top, totalAmount, totalProfit };
}

/**
 * 商品 TOP 4 看板（月榜从视图，日榜从 RPC）。
 * 月榜：视图按 target 周期聚合（含脱敏 sale_profit/outbound_profit）。
 * 日榜：RPC get_item_top_by_day 返 7 列（含脱敏利润），前端 toBoard 排序+TOP20+totals。
 */
export async function getItemBreakdownTop(
  targetId: number,
  closed?: boolean,
): Promise<ItemBreakdownTop> {
  const emptyBoard: TopBoard = { rows: [], totalAmount: 0, totalProfit: 0 };
  const empty: ItemBreakdownTop = {
    saleMonth: { ...emptyBoard },
    saleDay: { ...emptyBoard },
    outboundMonth: { ...emptyBoard },
    outboundDay: { ...emptyBoard },
    defaultDay: "",
  };

  const client = await getClient();

  // 取目标周期，算默认日：今天在周期内->今天；今天>end->end；今天<start->start
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

  // 月榜：closed 读快照（close_target 全量快照视图输出）；active 查视图
  let monthArr: Array<Record<string, unknown>>;
  if (closed) {
    const snap = await getSnapshotRows(targetId, "item");
    monthArr = (snap ?? []) as unknown as Array<Record<string, unknown>>;
  } else {
    const { data: monthRows, error: mErr } = await client.database
      .from("report_item_breakdown_gen")
      .select(
        "item_code,item_name,category_name,sale_amount,sale_profit,outbound_amount,outbound_profit",
      )
      .eq("target_id", targetId);
    if (mErr) {
      console.error("getItemBreakdownTop: month view fetch failed:", mErr);
      return { ...empty, defaultDay };
    }
    monthArr = (monthRows ?? []) as unknown as Array<Record<string, unknown>>;
  }
  const saleMonth = toBoard(monthArr, "sale_amount", "sale_profit");
  const outboundMonth = toBoard(monthArr, "outbound_amount", "outbound_profit");

  // 日榜：调 RPC（migration 145 后返 7 列含脱敏利润）
  const { data: dayRows, error: dErr } = await client.database.rpc(
    "get_item_top_by_day",
    { p_target_id: targetId, p_day: defaultDay },
  );
  if (dErr) {
    console.error("getItemBreakdownTop: day RPC failed:", dErr);
    return {
      saleMonth,
      saleDay: { ...emptyBoard },
      outboundMonth,
      outboundDay: { ...emptyBoard },
      defaultDay,
    };
  }
  const dayArr = (dayRows ?? []) as unknown as Array<Record<string, unknown>>;
  const saleDay = toBoard(dayArr, "sale_amount", "sale_profit");
  const outboundDay = toBoard(dayArr, "outbound_amount", "outbound_profit");

  return { saleMonth, saleDay, outboundMonth, outboundDay, defaultDay };
}

export interface ItemOutboundListRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  top_category: string | null;
  category_group: string | null;
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
  filters: { category?: string; brand?: string; q?: string },
): Promise<{ rows: ItemOutboundListRow[]; total: number }> {
  const client = await getClient();
  let query = client.database
    .from("report_item_breakdown_gen")
    .select(
      "item_code,item_name,category_name,top_category,category_group,delivery_amount,wholesale_amount,outbound_amount",
      { count: "exact" },
    )
    .eq("target_id", targetId);
  if (filters.category) query = query.eq("category_group", filters.category);
  // 注：原 filters.brand -> item_brand 筛选已移除（item_brand 是 manufacturer brand，脏值+跨品牌粒度，会导致 0 行）。
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
    category_group: r.category_group == null ? null : String(r.category_group),
    delivery_amount: Number(r.delivery_amount || 0),
    wholesale_amount: Number(r.wholesale_amount || 0),
    outbound_amount: Number(r.outbound_amount || 0),
    pct: 0,
  }));
  return { rows, total: count ?? 0 };
}
