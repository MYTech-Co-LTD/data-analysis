// web/lib/report-center/region-breakdown.ts
// 门店零售/配送数据报表下钻数据获取
// P2: 切换到语义层生成器产物（口径源自 metric_registry，三级层级生成器产出，双轨 diff=0 已验证）
import { getClient } from "@/lib/api";

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
  targetId: string
): Promise<RegionBreakdownRow[]> {
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_region_breakdown_gen")
    .select("*")
    .eq("target_id", targetId)
    .order("sale_rate", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("Failed to fetch region breakdown:", error);
    return [];
  }

  return (data ?? []) as RegionBreakdownRow[];
}
