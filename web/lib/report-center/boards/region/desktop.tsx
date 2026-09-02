"use client";

// web/lib/report-center/boards/region/desktop.tsx
// 门店战区板块渲染适配器：把宿主注入的 BoardProps 映射到 RegionDrillTable 既有 props（复用，不重写）。
import { RegionDrillTable } from "@/components/report-center/region-drill-table";
import type { BoardProps } from "@/lib/contracts";
import type { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";

export function RegionBoard({
  result,
  target,
  targetMonth,
  progress,
  isMobile,
}: BoardProps<RegionBreakdownRow>) {
  const table = (
    <RegionDrillTable
      result={result}
      targetMonth={targetMonth}
      progress={progress}
      closed={target.status === "closed"}
      isMobile={isMobile}
    />
  );
  return isMobile ? (
    <div>{table}</div>
  ) : (
    <div className="md:col-span-2">{table}</div>
  );
}
