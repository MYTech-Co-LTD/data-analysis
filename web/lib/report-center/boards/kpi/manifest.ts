// web/lib/report-center/boards/kpi/manifest.ts
// KPI 指标板块（P4）：serverGet = 现有 getTargetKpi 迁入（逻辑不动）；
// Desktop/Mobile 复用 components/report-center/kpi-cards（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import { getTargetKpi, type TargetKpiRow } from "@/lib/report-center/targets";
import { KpiBoard } from "./desktop";

export const kpiBoard: BoardManifest<TargetKpiRow> = {
  id: "kpi",
  serverGet: (targetId) => getTargetKpi(targetId),
  Desktop: KpiBoard,
  menuLabel: "指标概览",
};
