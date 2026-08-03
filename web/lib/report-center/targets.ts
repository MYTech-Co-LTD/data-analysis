// web/lib/report-center/targets.ts
// 读 report_achievement_v：目标列表(total行) + total 详情(4指标KPI)
import { getClient } from "@/lib/api";

export interface TargetSummary {
  target_id: number; name: string; status: "active"|"closed";
  target_type: "store"|"hq"; start_date: string; end_date: string;
  // 概览：主指标达成率（取该目标的第一个指标，列表卡用）
  sample_metric: string; sample_achievement_rate: number; sample_progress_rate: number;
}

// 目标列表：DISTINCT total 行（一个目标 4 指标 → 取一行代表）
export async function getTargetList(status?: "active"|"closed"): Promise<TargetSummary[]> {
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
  return [...byId.values()];
}

// total 详情：该目标全指标 KPI 行
export async function getTargetKpi(targetId: number) {
  const client = await getClient();
  const { data, error } = await client.database.from("report_achievement_gen")
    .select("*").eq("target_id", targetId).eq("target_level","total");
  if (error) throw error;
  return data ?? [];  // 每行一个 metric_code 的 KPI
}
