// web/lib/report-center/category-summary.ts
// 类别出库报表数据获取
import { getClient } from "@/lib/api";
import { getSnapshotRows } from "./target-snapshot";

export interface CategorySummaryRow {
  target_id: number;
  category: '水果' | '标品' | '耗材' | '合计';
  sale_target: number;
  sale_actual: number;
  sale_rate: number | null;
  profit_target: number;
  profit_actual: number | null;  // 脱敏时视图返 NULL（can_see_cost=false）
  profit_rate: number | null;
  profit_margin: number | null;
  daily_amount: number;
  daily_profit: number | null;  // 脱敏时视图返 NULL（can_see_cost=false）
  daily_profit_margin: number | null;
  remaining_daily_profit_target: number;
}

const CATEGORY_ORDER = ['水果', '标品', '耗材', '合计'] as const;

export async function getCategorySummary(
  targetId: string,
  closed?: boolean
): Promise<CategorySummaryRow[]> {
  // 已定格目标：读快照（视图不再算 closed 目标）
  if (closed) {
    const snap = await getSnapshotRows(Number(targetId), "category");
    if (snap) return (snap as CategorySummaryRow[]).sort((a, b) => CATEGORY_ORDER.indexOf(a.category as any) - CATEGORY_ORDER.indexOf(b.category as any));
  }
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_category_summary_gen")
    .select("*")
    .eq("target_id", targetId);

  if (error) {
    console.error("Failed to fetch category summary:", error);
    return [];
  }

  // 按固定顺序排序：水果→标品→耗材→合计
  const sorted = (data ?? []).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a.category as any);
    const idxB = CATEGORY_ORDER.indexOf(b.category as any);
    return idxA - idxB;
  });

  return sorted as CategorySummaryRow[];
}
