"use client";

// web/lib/report-center/boards/kpi/desktop.tsx
// KPI 板块渲染适配器：把宿主注入的 BoardProps 映射到 KpiCards 既有 props（复用，不重写）。
// 桌面端整行（md:col-span-2），移动端 px-4 容器（对齐旧 mobile.tsx 布局）。
import { KpiCards } from "@/components/report-center/kpi-cards";
import type { BoardProps } from "@/lib/contracts";
import type { TargetKpiRow } from "@/lib/report-center/targets";

export function KpiBoard({ result, isMobile }: BoardProps<TargetKpiRow>) {
  return isMobile ? (
    <div className="px-4">
      <KpiCards result={result} isMobile />
    </div>
  ) : (
    <div className="md:col-span-2">
      <KpiCards result={result} />
    </div>
  );
}
