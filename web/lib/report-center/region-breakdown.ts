// web/lib/report-center/region-breakdown.ts
// 门店零售/配送数据报表下钻数据获取
// P2: 切换到语义层生成器产物（口径源自 metric_registry，三级层级生成器产出，双轨 diff=0 已验证）
//
// F1.1（前端数据准确性守护 P0）：返 GetterResult<RegionBreakdownRow>，吞错改 status='error'。
// 保留 closed 分支 "有快照用快照、无快照 fall-through live" 行为，select 字段不变。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";
import { getSnapshotRows } from "./target-snapshot";

export interface RegionBreakdownRow {
  target_id: number;
  level: 'region' | 'sub_region' | 'store';
  parent_code: string | null;
  region_code: string;
  region_name: string;
  sub_region_code: string | null;
  sub_region_name: string | null;
  branch_num: string | null;
  branch_name: string | null;
  sale_target: number;
  sale_actual: number;
  sale_rate: number | null;
  delivery_target: number;
  delivery_actual: number;
  delivery_rate: number | null;
  daily_sale: number;
  daily_delivery: number;
  remaining_daily_sale_target: number;
  remaining_daily_delivery_target: number;
}

export async function getRegionBreakdown(
  targetId: string,
  closed?: boolean
): Promise<GetterResult<RegionBreakdownRow>> {
  // 已定格目标：读 close_target 全量快照（视图不再算 closed 目标）
  if (closed) {
    try {
      const snap = await getSnapshotRows(Number(targetId), "region");
      if (snap.status === "ok") {
        return okResult(
          (snap.rows as RegionBreakdownRow[]).sort((a, b) => (b.sale_rate ?? 0) - (a.sale_rate ?? 0))
        );
      }
      // snap.status !== 'ok'：保持原 fall-through 行为（无快照即查 live）
    } catch (e) {
      console.error("region_breakdown snapshot:", e);
      return errorResult<RegionBreakdownRow>([], wrapError(e));
    }
  }

  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("report_region_breakdown_gen")
      .select("*")
      .eq("target_id", targetId)
      .order("sale_rate", { ascending: false, nullsFirst: false });

    if (error) throw error;
    return okResult((data ?? []) as RegionBreakdownRow[]);
  } catch (e) {
    console.error("Failed to fetch region breakdown:", e);
    return errorResult<RegionBreakdownRow>([], wrapError(e));
  }
}
