// web/lib/report-center/boards/item-top/manifest.ts
// 商品 TOP 板块（P4）：serverGet = 现有 getItemBreakdownTop 迁入（逻辑不动，含 closed 快照/日榜 RPC）。
// getItemBreakdownTop 返回 ItemBreakdownResult（4 个 TopBoard，非单 rows 数组），按契约包成
// GetterResult<ItemBreakdownResult>（rows[0] = 原结果，status/error 透传，失败时组件仍能显示
// 带 error 详情的占位）；Desktop/Mobile 复用 components/report-center/item-top-boards
// （销售+出库共用日榜 day state，不重写）。
import type { BoardManifest } from "@/lib/contracts";
import {
  getItemBreakdownTop,
  type ItemBreakdownResult,
} from "@/lib/report-center/item-breakdown";
import { ItemTopBoard } from "./desktop";

export const itemTopBoard: BoardManifest<ItemBreakdownResult> = {
  id: "item-top",
  serverGet: async (targetId, opts) => {
    // 宿主透传的周期（BoardCtx 扩展键）——避开 targets 表的 branch RLS（门店用户看不到 ALL 目标）
    const dates = {
      startDate: typeof opts.startDate === "string" ? opts.startDate : undefined,
      endDate: typeof opts.endDate === "string" ? opts.endDate : undefined,
    };
    const r = await getItemBreakdownTop(targetId, opts.closed, dates);
    return { rows: [r], status: r.status, error: r.error };
  },
  Desktop: ItemTopBoard,
  menuLabel: "商品 TOP",
};
