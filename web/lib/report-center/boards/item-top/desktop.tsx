"use client";

// web/lib/report-center/boards/item-top/desktop.tsx
// 商品 TOP 板块渲染适配器：复用 components/report-center/item-top-boards（不重写）。
// 2026-08-19 拆分（用户裁定）：销售/出库两个独立看板（各自能力 key 可单独配置）。
// 两个看板各自调 useItemDayBoards（同一 RPC 取数幂等，React 缓存去重；day state 各自独立）。
import {
  OutboundTopBoards,
  SaleTopBoards,
  useItemDayBoards,
} from "@/components/report-center/item-top-boards";
import type { BoardProps } from "@/lib/contracts";
import type {
  ItemBreakdownResult,
  TopBoard,
} from "@/lib/report-center/item-breakdown";

// M10：宿主 allSettled rejected 兜底给 { rows: [], status: 'error' } 时的空板——
// totalProfit 用 null（脱敏语义，0 会误导显示 ¥0），status='error'（与原 page 兜底一致）。
function emptyItemTop(): ItemBreakdownResult {
  const emptyBoard: TopBoard = { rows: [], totalAmount: 0, totalProfit: null };
  return {
    saleMonth: { ...emptyBoard },
    saleDay: { ...emptyBoard },
    outboundMonth: { ...emptyBoard },
    outboundDay: { ...emptyBoard },
    defaultDay: "",
    status: "error",
  };
}

function ItemTopSaleBoard({
  result,
  target,
  targetId,
  isMobile,
}: BoardProps<ItemBreakdownResult>) {
  const itemTop = result.rows[0] ?? emptyItemTop();
  // 拆分后销售看板只用 saleDay（useItemDayBoards 同签名保留出库位，渲染不消费）
  const { day, saleDay, onDayChange, busy } = useItemDayBoards(
    targetId,
    itemTop.defaultDay,
    itemTop.saleDay,
    itemTop.outboundDay,
  );
  const boards = (
    <SaleTopBoards
      result={itemTop}
      dayBoard={saleDay}
      day={day}
      onDayChange={onDayChange}
      busy={busy}
      startDate={target.start_date}
      endDate={target.end_date}
      targetId={targetId}
    />
  );
  return isMobile ? (
    <div className="space-y-4">{boards}</div>
  ) : (
    <div className="space-y-5 md:col-span-2">{boards}</div>
  );
}

function ItemTopOutboundBoard({
  result,
  target,
  targetId,
  isMobile,
}: BoardProps<ItemBreakdownResult>) {
  const itemTop = result.rows[0] ?? emptyItemTop();
  // 出库看板只用 outboundDay
  const { day, outboundDay, onDayChange, busy } = useItemDayBoards(
    targetId,
    itemTop.defaultDay,
    itemTop.saleDay,
    itemTop.outboundDay,
  );
  const boards = (
    <OutboundTopBoards
      result={itemTop}
      dayBoard={outboundDay}
      day={day}
      onDayChange={onDayChange}
      busy={busy}
      startDate={target.start_date}
      endDate={target.end_date}
      targetId={targetId}
    />
  );
  return isMobile ? (
    <div className="space-y-4">{boards}</div>
  ) : (
    <div className="space-y-5 md:col-span-2">{boards}</div>
  );
}

export { ItemTopSaleBoard, ItemTopOutboundBoard };
