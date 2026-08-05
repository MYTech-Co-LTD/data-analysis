// web/lib/report-center/category-summary.ts
// 类别出库报表数据获取
//
// F1.1（前端数据准确性守护 P0）：返 GetterResult<CategorySummaryRow>，吞错改 status='error'。
// 保留 closed 分支 "有快照用快照、无快照 fall-through live" 行为，select 字段不变。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";
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
): Promise<GetterResult<CategorySummaryRow>> {
  // 已定格目标：读快照（视图不再算 closed 目标）
  if (closed) {
    try {
      const snap = await getSnapshotRows(Number(targetId), "category");
      if (snap.status === "ok") {
        return okResult(
          (snap.rows as CategorySummaryRow[]).sort(
            (a, b) =>
              CATEGORY_ORDER.indexOf(a.category as any) -
              CATEGORY_ORDER.indexOf(b.category as any)
          )
        );
      }
      // snap.status !== 'ok'：保持原 fall-through 行为（无快照即查 live）
    } catch (e) {
      console.error("category_summary snapshot:", e);
      return errorResult<CategorySummaryRow>([], wrapError(e));
    }
  }

  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("report_category_summary_gen")
      .select("*")
      .eq("target_id", targetId);

    if (error) throw error;

    // 按固定顺序排序：水果→标品→耗材→合计
    const sorted = (data ?? []).sort((a, b) => {
      const idxA = CATEGORY_ORDER.indexOf(a.category as any);
      const idxB = CATEGORY_ORDER.indexOf(b.category as any);
      return idxA - idxB;
    });

    return okResult(sorted as CategorySummaryRow[]);
  } catch (e) {
    console.error("Failed to fetch category summary:", e);
    return errorResult<CategorySummaryRow>([], wrapError(e));
  }
}
