"use client";

// web/lib/report-center/boards/kpi/desktop.tsx
// KPI 板块渲染适配器：把宿主注入的 BoardProps 映射到 KpiCards 既有 props（复用，不重写）。
// 桌面端整行（md:col-span-2），移动端直接容器（gutter 由宿主 main px-3 提供，避免三重内边距挤压表格宽度）。
import { KpiCards } from "@/components/report-center/kpi-cards";
import type { BoardProps } from "@/lib/contracts";
import type { TargetKpiRow } from "@/lib/report-center/targets";

export function KpiBoard({ result, isMobile, permissions }: BoardProps<TargetKpiRow>) {
  return isMobile ? (
    <div>
      <KpiCards result={result} isMobile permissions={permissions} />
    </div>
  ) : (
    <div className="md:col-span-2">
      <KpiCards result={result} permissions={permissions} />
    </div>
  );
}
