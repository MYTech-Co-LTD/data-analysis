"use client";

// web/lib/report-center/boards/supply-chain/desktop.tsx
// 供应链出库板块渲染适配器：把宿主注入的 BoardProps 映射到 SupplyChainOutboundTable 既有 props（复用，不重写）。
// 桌面端为 grid 半格（与 wholesale 并排，供应链高度权威）；移动端直接容器（gutter 由宿主 main px-3 提供）。
import { SupplyChainOutboundTable } from "@/components/report-center/supply-chain-outbound-table";
import type { BoardProps } from "@/lib/contracts";
import type { SupplyChainOutboundRow } from "@/lib/report-center/supply-chain-outbound";

export function SupplyChainBoard({
  result,
  target,
  targetId,
  isMobile,
}: BoardProps<SupplyChainOutboundRow>) {
  const table = (
    <SupplyChainOutboundTable
      result={result}
      startDate={target.start_date}
      endDate={target.end_date}
      targetId={targetId}
      isMobile={isMobile}
    />
  );
  return isMobile ? <div>{table}</div> : table;
}
