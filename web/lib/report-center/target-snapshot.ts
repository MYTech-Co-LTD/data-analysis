// web/lib/report-center/target-snapshot.ts
// 目标定格快照读取：closed 目标看板从 target_snapshot_breakdowns 读冻结数据
// （close_target 关闭时把各看板模块视图输出全量快照成 JSONB，怎么展示的就怎么存）。
// active 目标照旧查实时视图；closed 目标各模块 getter 调 getSnapshotRows 分支。
import { getClient } from "@/lib/api";

export async function getSnapshotRows(
  targetId: number,
  module: string,
): Promise<unknown[] | null> {
  const client = await getClient();
  const { data, error } = await client.database
    .from("target_snapshot_breakdowns")
    .select("data")
    .eq("target_id", targetId)
    .eq("module", module)
    .single();
  if (error || !data?.data) return null;
  return data.data as unknown[];
}
