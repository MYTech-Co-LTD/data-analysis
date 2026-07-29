// web/lib/report-center/brand-metric.ts
// 品牌×指标表数据获取（report_brand_metric_v，3 行：熊喵/品品甜/合计）
import { getClient } from "@/lib/api";

export interface BrandMetricRow {
  target_id: number;
  system_book_code: string; // '3120' / '64188' / '合计'
  brand_name: string | null;
  sale_target: number;
  sale_amount: number;
  sale_rate: number | null; // 时间进度调整完成率
  delivery_amount: number;
  delivery_profit: number | null; // can_see_cost=false → NULL
  delivery_margin: number | null;
}

export async function getBrandMetric(
  targetId: number
): Promise<BrandMetricRow[]> {
  const client = await getClient();
  const { data, error } = await client.database
    .from("report_brand_metric_v")
    .select("*")
    .eq("target_id", targetId)
    .order("system_book_code", { ascending: true }); // 3120, 64188, 合计
  if (error) {
    console.error("brand_metric fetch:", error);
    return [];
  }
  return (data ?? []) as BrandMetricRow[];
}
