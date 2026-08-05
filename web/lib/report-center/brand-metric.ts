// web/lib/report-center/brand-metric.ts
// 品牌×指标表数据获取（report_brand_metric_gen，3 行：熊喵/品品甜/合计）
// P1: 切换到语义层生成器产物（口径源自 metric_registry，双轨 diff=0 已验证）
//
// F1.1（前端数据准确性守护 P0）：返回类型从裸 BrandMetricRow[] 改为 GetterResult<BrandMetricRow>，
// 把"出错返 []"和"真无数据返 []"分开了——前者 status='error' + AppError，后者 status='no-data'。
// 上层可据此决定 toast / 重试 / 占位，不再被裸 [] 误导成"没数据"。
//
// 改造原则（按 task-1-brief 关键上下文 #1）：保留 closed 分支逻辑和 select 字段不变，
// 只把所有 return 包成 GetterResult，并加 try/catch → errorResult。
// → closed 分支原本就有的"snapshot 缺失时 fall through 到 live 查询"行为保留（不改为 error）。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";
import { getSnapshotRows } from "./target-snapshot";

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
  targetId: number,
  closed?: boolean
): Promise<GetterResult<BrandMetricRow>> {
  // 已定格目标：读快照（closed 分支逻辑不变，只把 return 包成 GetterResult）
  if (closed) {
    try {
      const snap = await getSnapshotRows(targetId, "brand");
      if (snap) {
        return okResult(
          (snap as BrandMetricRow[]).sort((a, b) =>
            a.system_book_code.localeCompare(b.system_book_code)
          )
        );
      }
      // snap === null：保持原 fall-through 行为，继续走下面的 live 查询
    } catch (e) {
      console.error("brand_metric snapshot:", e);
      return errorResult<BrandMetricRow>([], wrapError(e));
    }
  }

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
