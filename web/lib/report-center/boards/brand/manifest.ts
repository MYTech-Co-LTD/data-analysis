// web/lib/report-center/boards/brand/manifest.ts
// 品牌×指标板块（P4）：serverGet = 现有 getBrandMetric 迁入（逻辑不动）；
// Desktop/Mobile 复用 components/report-center/brand-metric-table（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import { getBrandMetric, type BrandMetricRow } from "@/lib/report-center/brand-metric";
import { BrandBoard } from "./desktop";

export const brandBoard: BoardManifest<BrandMetricRow> = {
  id: "brand",
  serverGet: (targetId, _opts) => getBrandMetric(targetId),
  Desktop: BrandBoard,
  menuLabel: "品牌×指标",
};
