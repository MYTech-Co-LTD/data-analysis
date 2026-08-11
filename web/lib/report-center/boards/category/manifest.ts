// web/lib/report-center/boards/category/manifest.ts
// 类别出库板块（P4）：serverGet = 现有 getCategorySummary 迁入（逻辑不动，含 closed 快照分支；
// getter 签名 targetId 为 string，宿主传入 number 在此转换，与原 page 传 params.id 等价）。
// Desktop/Mobile 复用 components/report-center/category-summary（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import { getCategorySummary, type CategorySummaryRow } from "@/lib/report-center/category-summary";
import { CategoryBoard } from "./desktop";

export const categoryBoard: BoardManifest<CategorySummaryRow> = {
  id: "category",
  serverGet: (targetId, opts) => getCategorySummary(String(targetId), opts.closed),
  Desktop: CategoryBoard,
  menuLabel: "类别出库",
};
