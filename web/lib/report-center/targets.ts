// web/lib/report-center/targets.ts
// 读 report_achievement_v：目标列表(total行) + total 详情(4指标KPI)
//
// F1.2（前端数据准确性守护 P0）：getTargetList / getTargetKpi 返回类型从裸 [] 改为 GetterResult，
// 不再 throw 把"出错"和"真无数据"混淆——前者 status='error' + AppError，后者 status='no-data'。
// 关键收益：getTargetKpi 失败不再触发 error.tsx 挂掉整页看板（Task 4 会用 allSettled 进一步兜底）。
//
// 改造原则（按 task-3-brief，照 Task 1 brand-metric.ts 范本）：
// - 签名 → Promise<GetterResult<...>>
// - getClient 在 try 内
// - 成功 okResult(...)；catch errorResult([], wrapError(e))
// - 不再 throw
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";

export interface TargetSummary {
  target_id: number; name: string; status: "active"|"closed";
  target_type: "store"|"hq"; start_date: string; end_date: string;
  // 概览：主指标达成率（取该目标的第一个指标，列表卡用）
  sample_metric: string; sample_achievement_rate: number; sample_progress_rate: number;
}

// total 详情 KPI 行：每个 metric_code 一行（sale/delivery/outbound_amt/outbound_profit）。
// 字段对齐 report_achievement_gen 视图 + KpiCards 消费（metric_code/target_value/actual_value/
// achievement_rate/progress_rate/data_status 等）。
export interface TargetKpiRow {
  target_id: number;
  metric_code: string;
  target_level: string;
  target_value: number;
  actual_value: number | null;
  achievement_rate: number | null;
  progress_rate: number | null;
  data_status: string;
  [key: string]: unknown; // 视图其它透传字段（name/status/start_date/end_date/...）
}

// 目标列表：DISTINCT total 行（一个目标 4 指标 → 取一行代表）
export async function getTargetList(
  status?: "active"|"closed"
): Promise<GetterResult<TargetSummary>> {
  try {
    const client = await getClient();
    let q = client.database.from("report_achievement_gen").select("*").eq("target_level","total");
    if (status) q = q.eq("status", status);
    const { data, error } = await q.order("status").order("start_date",{ascending:false});
    if (error) throw error;
    // 按 target_id 去重（取 metric_code 优先 sale 的行）
    const byId = new Map<number, TargetSummary>();
    for (const r of data ?? []) {
      if (byId.has(r.target_id)) continue;
      byId.set(r.target_id, {
        target_id: r.target_id, name: r.name, status: r.status, target_type: r.target_type,
        start_date: r.start_date, end_date: r.end_date,
        sample_metric: r.metric_code, sample_achievement_rate: r.achievement_rate ?? 0,
        sample_progress_rate: r.progress_rate ?? 0,
      });
    }
    return okResult([...byId.values()]);
  } catch (e) {
    console.error("target_list fetch:", e);
    return errorResult<TargetSummary>([], wrapError(e));
  }
}

// total 详情：该目标全指标 KPI 行
export async function getTargetKpi(
  targetId: number
): Promise<GetterResult<TargetKpiRow>> {
  try {
    const client = await getClient();
    const { data, error } = await client.database.from("report_achievement_gen")
      .select("*").eq("target_id", targetId).eq("target_level","total");
    if (error) throw error;
    return okResult((data ?? []) as TargetKpiRow[]);
  } catch (e) {
    console.error("target_kpi fetch:", e);
    return errorResult<TargetKpiRow>([], wrapError(e));
  }
}
