// web/lib/report-center/boards/region/manifest.ts
// 门店战区板块（P4）：serverGet = 现有 getRegionBreakdown 迁入（逻辑不动；
// getter 签名 targetId 为 string，宿主传入 number 在此转换，与原 page 传 params.id 等价）。
// Desktop/Mobile 复用 components/report-center/region-drill-table（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import { getRegionBreakdown, type RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { RegionBoard } from "./desktop";

export const regionBoard: BoardManifest<RegionBreakdownRow> = {
  id: "region",
  serverGet: (targetId, _opts) => getRegionBreakdown(String(targetId)),
  Desktop: RegionBoard,
  menuLabel: "门店战区",
};
