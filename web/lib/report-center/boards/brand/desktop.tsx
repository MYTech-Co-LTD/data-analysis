"use client";

// web/lib/report-center/boards/brand/desktop.tsx
// 品牌×指标板块渲染适配器：把宿主注入的 BoardProps 映射到 BrandMetricTable 既有 props（复用，不重写）。
import { BrandMetricTable } from "@/components/report-center/brand-metric-table";
import type { BoardProps } from "@/lib/contracts";
import type { BrandMetricRow } from "@/lib/report-center/brand-metric";

export function BrandBoard({
  result,
  targetMonth,
  progress,
  isMobile,
}: BoardProps<BrandMetricRow>) {
  const table = (
    <BrandMetricTable
      result={result}
      targetMonth={targetMonth}
      progress={progress}
      isMobile={isMobile}
    />
  );
  return isMobile ? (
    <div className="px-4">{table}</div>
  ) : (
    <div className="md:col-span-2">{table}</div>
  );
}
