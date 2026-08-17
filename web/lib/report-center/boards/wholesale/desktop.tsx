"use client";

// web/lib/report-center/boards/wholesale/desktop.tsx
// 外部批发日报板块渲染适配器：把宿主注入的 BoardProps 映射到 WholesaleDailyTable 既有 props（复用，不重写）。
// 桌面端为 grid 半格（与供应链并排，随供应链高度滚动，保留旧 desktop.tsx 的 md:absolute 结构）；
// 移动端直接容器（gutter 由宿主 main px-3 提供）。
import { WholesaleDailyTable } from "@/components/report-center/wholesale-daily-table";
import type { BoardProps } from "@/lib/contracts";
import type { WholesaleDailyRow } from "@/lib/report-center/wholesale-daily";

export function WholesaleBoard({
  result,
  target,
  targetId,
  isMobile,
}: BoardProps<WholesaleDailyRow>) {
  const table = (
    <WholesaleDailyTable
      result={result}
      startDate={target.start_date}
      endDate={target.end_date}
      targetId={targetId}
      isMobile={isMobile}
    />
  );
  if (isMobile) return <div>{table}</div>;
  return (
    <div className="md:relative">
      <div className="md:absolute md:inset-0 md:overflow-y-auto">{table}</div>
    </div>
  );
}
