// web/lib/report-center/item-breakdown.ts
// 商品 TOP 4 独立看板（月度销售/日销售/月度出库/日出库）+ 出库明细分页
// 月榜走视图 report_item_breakdown_gen（含脱敏 sale_profit/outbound_profit）；
// 日榜走 RPC get_item_top_by_day（migration 145 后返 7 列含脱敏利润）。
//
// F1.1（前端数据准确性守护 P0）：
// - getItemBreakdownTop 返 ItemBreakdownResult（= ItemBreakdownTop + status/error），5 个错误分支吞错改 status='error'。
// - getItemOutboundListPage 返 ItemOutboundListResult（= {rows,total} + status/error），error 分支吞错改 status='error'。
//
// 形状偏差（已记入 task-2-report）：task-2-brief 给的 ItemBreakdownResult 形状
// `{rows,totalAmount,totalProfit,defaultDay}` 与真实代码结构不符——getItemBreakdownTop 实际返
// 4 个 TopBoard（saleMonth/saleDay/outboundMonth/outboundDay + defaultDay），不是单 board。
// 故 ItemBreakdownResult 改为 extends ItemBreakdownTop 加 status/error；dashboard 组件 prop
// 契约不变（结构兼容，多出来的 status/error 被忽略），page.tsx 也不需要解包（直接传 itemTop）。
// totalProfit 保持 number（按 brief #3 不动，Task 8 再改 number|null）。
import { getClient } from "@/lib/api";
import { wrapError, type AppError } from "@/lib/error";
import { type GetterStatus } from "./types";
import { cache } from "react";
import { cookies } from "next/headers";

// 2026-08-19 方案 B：受限用户（非全店）跳过 item 快照走 live 视图（快照=全店定格，无 scope 版本）；
// 解不开/无 token → 保守走 live。与 target-snapshot.ts isBranchScopeLimited 同源语义。
async function itemScopedUser(): Promise<boolean> {
  try {
    const token = (await cookies()).get("insforge_access_token")?.value;
    if (!token) return true;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as { data_scope?: { branch_nums?: unknown } };
    const bn = payload.data_scope?.branch_nums;
    return !(Array.isArray(bn) && bn.includes("*"));
  } catch {
    return true;
  }
}

export interface ItemTopRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  amount: number;
  profit: number | null; // 销售毛利/出库毛利（脱敏：无成本权限为 NULL 透传，不再压成 0）
  pct: number; // 占总金额比（0-1）
}

export interface TopBoard {
  rows: ItemTopRow[]; // TOP20
  totalAmount: number; // 全集合计金额（给合计行「总合计」用）
  totalProfit: number | null; // 全集合计毛利（脱敏：全 NULL 时为 null 透传，否则累加非 null）
}

export interface ItemBreakdownTop {
  saleMonth: TopBoard;
  saleDay: TopBoard;
  outboundMonth: TopBoard;
  outboundDay: TopBoard;
  defaultDay: string; // 默认日期 YYYY-MM-DD
}

// GetterResult 模式扩展：在 ItemBreakdownTop 数据形状上挂 status/error。
// 因 getItemBreakdownTop 返 4 个 board（不是单 rows 数组），不能直接用 GetterResult<ItemTopRow>。
export interface ItemBreakdownResult extends ItemBreakdownTop {
  status: GetterStatus;
  error?: AppError;
}

// 通用 TopBoard 构造器：按 amtKey 排序 + TOP20 + 利润 + totals（给合计行）
// F2.4: 脱敏利润（NULL）不再被 Number(null||0) 累加成 0——全脱敏 totalProfit=null 透传，
// 让下游显示「—」而不是误导性的「¥0」（与脱敏单项 profit=NULL 显示「—」一致）。
export function toBoard(
  rows: Array<Record<string, unknown>>,
  amtKey: string,
  profitKey: string,
): TopBoard {
  const totalAmount = rows.reduce((s, r) => s + Number(r[amtKey] || 0), 0);
  // F2.4: 脱敏利润（NULL）透传。全集合 profit 都为 null 时 totalProfit=null（不当 0 累加，
  // 否则脱敏用户会看到「¥0 合计」误导有成本数据）；存在任一非 null 时只累加非 null 行。
  const profits: unknown[] = rows.map((r) => r[profitKey]);
  const totalProfit: number | null = profits.every((p) => p == null)
    ? null
    : profits.reduce<number>((s, p) => s + Number(p || 0), 0);
  const sorted = rows
    .slice()
    .sort((a, b) => Number(b[amtKey] || 0) - Number(a[amtKey] || 0));
  const top: ItemTopRow[] = sorted.slice(0, 20).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    amount: Number(r[amtKey] || 0),
    profit: r[profitKey] == null ? null : Number(r[profitKey]),
    pct: totalAmount > 0 ? Number(r[amtKey] || 0) / totalAmount : 0,
  }));
  return { rows: top, totalAmount, totalProfit };
}

/**
 * 商品 TOP 4 看板（月榜从视图，日榜从 RPC）。
 * 月榜：视图按 target 周期聚合（含脱敏 sale_profit/outbound_profit）。
 * 日榜：RPC get_item_top_by_day 返 7 列（含脱敏利润），前端 toBoard 排序+TOP20+totals。
 */
// cache()（2026-08-19 性能修复）：商品销售/出库两个看板各自调一次 getItemBreakdownTop，
// 参数相同 → 请求级去重（此前同视图 507KB 拉两次）。请求上下文外（测试/脚本）自动退化为直调。
export const getItemBreakdownTop = cache(async function getItemBreakdownTop(
  targetId: number,
  closed?: boolean,
  dates?: { startDate?: string; endDate?: string },
): Promise<ItemBreakdownResult> {
  const emptyBoard: TopBoard = { rows: [], totalAmount: 0, totalProfit: 0 };
  const empty: ItemBreakdownResult = {
    saleMonth: { ...emptyBoard },
    saleDay: { ...emptyBoard },
    outboundMonth: { ...emptyBoard },
    outboundDay: { ...emptyBoard },
    defaultDay: "",
    status: "no-data",
  };

  try {
    const client = await getClient();

    // 取目标周期，算默认日：今天在周期内->今天；今天>end->end；今天<start->start。
    // 宿主已从 RLS 可见的报表视图拿到周期时透传 dates，跳过对 targets 底表的直查——
    // targets 有 branch RLS，门店权限用户看不到 branch_num='ALL' 的全司目标（PGRST116），
    // 曾导致 item-top 板块整板「加载失败」。
    let startDate: string;
    let endDate: string;
    if (dates?.startDate && dates?.endDate) {
      startDate = dates.startDate;
      endDate = dates.endDate;
    } else {
      const { data: t, error: tErr } = await client.database
        .from("targets")
        .select("start_date,end_date")
        .eq("id", targetId)
        .single();
      if (tErr || !t) {
        console.error("getItemBreakdownTop: target fetch failed:", tErr);
        return { ...empty, status: "error", error: wrapError(tErr ?? new Error("target not found")) };
      }
      startDate = t.start_date;
      endDate = t.end_date;
    }
    const today = new Date().toISOString().slice(0, 10);
    const defaultDay =
      today >= startDate && today <= endDate
        ? today
        : today > endDate
          ? endDate
          : startDate;

    // 月榜：closed 读 item_top 小快照（TOP20+total，几KB，避免读全量 item 2.58MB 拖慢 SSR）；
    //       active 查视图全量（toBoard 算 TOP20）
    let saleMonth: TopBoard;
    let outboundMonth: TopBoard;
    if (closed && !(await itemScopedUser())) {
      // 受限用户跳过快照（方案 B）：走下方 live 视图（tgt 已含 closed 目标）
      const { data: snap, error: sErr } = await client.database
        .from("target_snapshot_breakdowns")
        .select("data")
        .eq("target_id", targetId)
        .eq("module", "item_top")
        .single();
      if (sErr || !snap?.data) {
        console.error("getItemBreakdownTop: item_top snapshot missing:", sErr);
        return {
          ...empty,
          defaultDay,
          status: "error",
          error: wrapError(sErr ?? new Error("item_top snapshot missing")),
        };
      }
      const d = snap.data as {
        saleTop?: Array<{ item_code: string; item_name: string; category_name: string | null; sale_amount: number; sale_profit: number | null }>;
        outboundTop?: Array<{ item_code: string; item_name: string; category_name: string | null; outbound_amount: number; outbound_profit: number | null }>;
        totalSaleAmount?: number; totalSaleProfit?: number; totalOutboundAmount?: number; totalOutboundProfit?: number;
      };
      saleMonth = {
        rows: (d.saleTop ?? []).map((r) => ({ item_code: String(r.item_code ?? ""), item_name: String(r.item_name ?? ""), category_name: r.category_name == null ? null : String(r.category_name), amount: Number(r.sale_amount ?? 0), profit: Number(r.sale_profit ?? 0), pct: (d.totalSaleAmount ?? 0) > 0 ? Number(r.sale_amount ?? 0) / (d.totalSaleAmount ?? 0) : 0 })),
        totalAmount: d.totalSaleAmount ?? 0, totalProfit: d.totalSaleProfit ?? 0,
      };
      outboundMonth = {
        rows: (d.outboundTop ?? []).map((r) => ({ item_code: String(r.item_code ?? ""), item_name: String(r.item_name ?? ""), category_name: r.category_name == null ? null : String(r.category_name), amount: Number(r.outbound_amount ?? 0), profit: Number(r.outbound_profit ?? 0), pct: (d.totalOutboundAmount ?? 0) > 0 ? Number(r.outbound_amount ?? 0) / (d.totalOutboundAmount ?? 0) : 0 })),
        totalAmount: d.totalOutboundAmount ?? 0, totalProfit: d.totalOutboundProfit ?? 0,
      };
    } else {
      const { data: monthRows, error: mErr } = await client.database
        .from("report_item_breakdown_gen")
        .select("item_code,item_name,category_name,sale_amount,sale_profit,outbound_amount,outbound_profit")
        .eq("target_id", targetId);
      if (mErr) {
        console.error("getItemBreakdownTop: month view fetch failed:", mErr);
        return { ...empty, defaultDay, status: "error", error: wrapError(mErr) };
      }
      const monthArr = (monthRows ?? []) as unknown as Array<Record<string, unknown>>;
      saleMonth = toBoard(monthArr, "sale_amount", "sale_profit");
      outboundMonth = toBoard(monthArr, "outbound_amount", "outbound_profit");
    }

    // 日榜：调 RPC（closed 目标 RPC 读底表不依赖 target_status；migration 158 后 pos_item_code lateral）
    const { data: dayRows, error: dErr } = await client.database.rpc(
      "get_item_top_by_day",
      { p_target_id: targetId, p_day: defaultDay },
    );
    if (dErr) {
      console.error("getItemBreakdownTop: day RPC failed:", dErr);
      // 月榜已成功（有数据），仅日榜 RPC 失败：保留月榜数据（dashboard 仍可显示月榜），
      // 但整体 status='error'（按 brief "5 个错误分支都改 error"），让上层能感知日榜缺失。
      return {
        saleMonth,
        saleDay: { ...emptyBoard },
        outboundMonth,
        outboundDay: { ...emptyBoard },
        defaultDay,
        status: "error",
        error: wrapError(dErr),
      };
    }
    const dayArr = (dayRows ?? []) as unknown as Array<Record<string, unknown>>;
    const saleDay = toBoard(dayArr, "sale_amount", "sale_profit");
    const outboundDay = toBoard(dayArr, "outbound_amount", "outbound_profit");

    return { saleMonth, saleDay, outboundMonth, outboundDay, defaultDay, status: "ok" };
  } catch (e) {
    console.error("getItemBreakdownTop:", e);
    return { ...empty, status: "error", error: wrapError(e) };
  }
});

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

// getItemOutboundListPage 返 {rows,total} 形状；挂 status/error 成 GetterResult 风格。
export interface ItemOutboundListResult {
  rows: ItemOutboundListRow[];
  total: number;
  status: GetterStatus;
  error?: AppError;
}

/**
 * 出库明细分页：按 outbound_amount 倒序，每页 50 行。
 * 占比留给前端基于完整 total 计算（避免 server 端二次全量查询）。
 */
export async function getItemOutboundListPage(
  targetId: number,
  page: number,
  filters: { category?: string; brand?: string; q?: string },
): Promise<ItemOutboundListResult> {
  try {
    const client = await getClient();
    // closed 目标：读 item 全量快照分页（展开抽屉才调，按需加载；不查视图因 closed 视图 tgt 不含此 target）
    const { data: t } = await client.database.from("targets").select("status").eq("id", targetId).single();
    if (t?.status === "closed" && !(await itemScopedUser())) {
      // 受限用户跳过全量快照，走下方 live 查询（方案 B）
      const { data: snap } = await client.database
        .from("target_snapshot_breakdowns")
        .select("data")
        .eq("target_id", targetId)
        .eq("module", "item")
        .single();
      let all = (snap?.data ?? []) as Array<Record<string, unknown>>;
      if (filters.category) all = all.filter((r) => r.category_group === filters.category);
      if (filters.q) {
        const q = filters.q.toLowerCase();
        all = all.filter((r) => String(r.item_name ?? "").toLowerCase().includes(q));
      }
      all.sort((a, b) => Number(b.outbound_amount ?? 0) - Number(a.outbound_amount ?? 0));
      const total = all.length;
      const start = (page - 1) * 50;
      const rows = all.slice(start, start + 50).map((r) => ({
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
      return { rows, total, status: "ok" };
    }
    // active: 查视图（原逻辑）
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
    if (error) throw error;
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
    return { rows, total: count ?? 0, status: "ok" };
  } catch (e) {
    console.error("getItemOutboundListPage: fetch failed:", e);
    return { rows: [], total: 0, status: "error", error: wrapError(e) };
  }
}
