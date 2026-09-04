// web/lib/report-center/brand-metric.ts
// 品牌×指标表数据获取（report_brand_metric_gen，3 行：熊喵/品品甜/合计）
// P1: 切换到语义层生成器产物（口径源自 metric_registry，双轨 diff=0 已验证）
//
// F1.1（前端数据准确性守护 P0）：返回类型从裸 BrandMetricRow[] 改为 GetterResult<BrandMetricRow>，
// 把"出错返 []"和"真无数据返 []"分开了——前者 status='error' + AppError，后者 status='no-data'。
// 上层可据此决定 toast / 重试 / 占位，不再被裸 [] 误导成"没数据"。
//
// 2026-09-02 千人千面：closed 目标下钻同样查 live 视图（视图 target_status ['active','closed']
// 实时重算 + 行级 scope 过滤），快照 JSONB 降级为审计存档，getter 不再读 target_snapshot_breakdowns。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";

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
): Promise<GetterResult<BrandMetricRow>> {
  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("report_brand_metric_gen")
      .select("*")
      .eq("target_id", targetId)
      .order("system_book_code", { ascending: true }); // 3120, 64188, 合计
    if (error) throw error;
    return okResult((data ?? []) as BrandMetricRow[]);
  } catch (e) {
    console.error("brand_metric fetch:", e);
    return errorResult<BrandMetricRow>([], wrapError(e));
  }
}
