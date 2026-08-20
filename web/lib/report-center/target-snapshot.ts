// web/lib/report-center/target-snapshot.ts
// 目标定格快照读取：closed 目标看板从 target_snapshot_breakdowns 读冻结数据
// （close_target 关闭时把各看板模块视图输出全量快照成 JSONB，怎么展示的就怎么存）。
// active 目标照旧查实时视图；closed 目标各模块 getter 调 getSnapshotRows 分支。
//
// F1.1（前端数据准确性守护 P0）：返 GetterResult<unknown>（不再裸 null）。
// 沿用原语义——error 或无快照都视为"无快照"（status='error'）；上层 closed 分支据此
// 走 fall-through 到 live 查询（保留"有快照用快照、无快照 fall-through live"行为）。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";
import { cookies } from "next/headers";

// 2026-08-19 方案 B（用户裁定）第二部分：受限用户（branch_nums 非 '*'）跳过快照走 live。
// 快照是关单时全店视角定格，无 scope 版本；live 视图自带 RLS 裁剪 + 194 语义。
// 判定仅做分流（展示路径选择），真实鉴权仍由 DB 层 RLS 兜底；解不开/无 token → 保守走 live。
async function isBranchScopeLimited(): Promise<boolean> {
  try {
    const token = (await cookies()).get("insforge_access_token")?.value;
    if (!token) return true;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as { data_scope?: { branch_nums?: unknown } };
    const bn = payload.data_scope?.branch_nums;
    return !(Array.isArray(bn) && bn.includes("*"));
  } catch {
    return true;
  }
}

export async function getSnapshotRows(
  targetId: number,
  module: string,
): Promise<GetterResult<unknown>> {
  // 受限用户：直接报"无快照"→上层 fall-through live（方案 B；全店用户保留定格语义）
  if (await isBranchScopeLimited()) {
    return errorResult([], wrapError(new Error("scoped user: live path")));
  }
  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("target_snapshot_breakdowns")
      .select("data")
      .eq("target_id", targetId)
      .eq("module", module)
      .single();
    if (error || !data?.data) {
      // 原 `return null` → errorResult（status='error'）；上层 closed 分支按 status 处理。
      // 不区分 "PostgREST error" 与 "data 缺失"，沿用原"都视为无快照"语义。
      return errorResult(
        [],
        wrapError(error ?? new Error("snapshot null")),
      );
    }
    return okResult(data.data as unknown[]);
  } catch (e) {
    console.error("getSnapshotRows:", e);
    return errorResult([], wrapError(e));
  }
}
