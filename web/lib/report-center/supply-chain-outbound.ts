// web/lib/report-center/supply-chain-outbound.ts
// 供应链出库（配送）三级层级下钻数据获取
// 视图 report_supply_chain_outbound_gen：region(战区) -> sub_region(二级区域) -> store(门店) 三级层级
// 口径源自语义层生成器（仅考核战区 is_assessed_war_zone 门店，branch_num<>'99' 配送中心）
// 脱敏：profit/margin 受 request.jwt.claims.can_see_cost 控制，无成本权限时视图返 NULL（非 0，前端自行处理）
// margin 为 round(x,4) 即 0-1 小数（0.1234 = 12.34%），amount=0 时 NULLIF 致 margin NULL
import { getClient } from "@/lib/api";
import { getSnapshotRows } from "./target-snapshot";

export interface SupplyChainOutboundRow {
  target_id: number;
  level: 'region' | 'sub_region' | 'store';
  parent_code: string | null;       // region 级 NULL；sub_region 级 = war_zone；store 级 = region_l2
  region_code: string;              // 各级均 = war_zone（战区名）
  region_name: string;              // 同 region_code
  sub_region_code: string | null;   // region 级 NULL；sub_region/store 级 = region_l2（二级区域名）
  sub_region_name: string | null;   // 同 sub_region_code
  branch_num: string | null;        // 仅 store 级有值
  branch_name: string | null;       // 仅 store 级有值
  war_zone: string | null;          // 仅 store 级有值（原始战区名，region/sub_region 级冗余 NULL）
  region_l2: string | null;         // 仅 store 级有值（原始二级区域名）
  delivery_amount: number;          // 周期配送金额（COALESCE 非 NULL）
  delivery_profit: number | null;   // 周期配送毛利（无成本权限时 NULL）
  delivery_margin: number | null;   // 周期毛利率 0-1（round 4 位，无成本权限或金额=0 时 NULL）
  daily_delivery_amount: number;    // 当天配送金额
  daily_delivery_profit: number | null; // 当天配送毛利（无成本权限时 NULL）
  daily_delivery_margin: number | null; // 当天毛利率 0-1（round 4 位，无成本权限或金额=0 时 NULL）
}

export async function getSupplyChainOutbound(
  targetId: number,
  closed?: boolean,
): Promise<SupplyChainOutboundRow[]> {
  // 已定格目标：读快照
  if (closed) {
    const snap = await getSnapshotRows(targetId, "supply");
    if (snap) return snap as SupplyChainOutboundRow[];
  }
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_supply_chain_outbound_gen")
    .select("*")
    .eq("target_id", targetId);

  if (error) {
    console.error("getSupplyChainOutbound: fetch failed:", error);
    return [];
  }

  return (data ?? []) as SupplyChainOutboundRow[];
}
