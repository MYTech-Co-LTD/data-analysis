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
  // md:absolute 结构依赖同行的供应链看板提供行高——只给外部批发权限（无供应链）时父容器
  // 高度为 0 → 看板塌缩不可见（2026-08-19 实测修复：加 min-height 保证独立可见；
  // 供应链在时行高更大，仍照旧随行高滚动）。
  return (
    <div className="md:relative md:min-h-[400px]">
      <div className="md:absolute md:inset-0 md:overflow-y-auto">{table}</div>
    </div>
  );
}
