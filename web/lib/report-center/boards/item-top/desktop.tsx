"use client";

// web/lib/report-center/boards/item-top/desktop.tsx
// 商品 TOP 板块渲染适配器：复用 components/report-center/item-top-boards（不重写）。
// 销售/出库共用 useItemDayBoards 日榜 day state（与旧 desktop/mobile.tsx 一致）；
// serverGet 把 ItemBreakdownResult 包成 GetterResult rows[0]，这里解回原对象。
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

export function ItemTopBoard({
  result,
  target,
  targetId,
  isMobile,
}: BoardProps<ItemBreakdownResult>) {
  // 正常路径 rows[0] = getItemBreakdownTop 原结果（含 status/error）；rejected 兜底走 M10 空板。
  const itemTop = result.rows[0] ?? emptyItemTop();
  // 日榜 day state（销售/出库共用，切日并行请求两 metric）
  const { day, saleDay, outboundDay, onDayChange, busy } = useItemDayBoards(
    targetId,
    itemTop.defaultDay,
    itemTop.saleDay,
    itemTop.outboundDay,
  );
  const startDate = target.start_date;
  const endDate = target.end_date;
  const boards = (
    <>
      <SaleTopBoards
        result={itemTop}
        dayBoard={saleDay}
        day={day}
        onDayChange={onDayChange}
        busy={busy}
        startDate={startDate}
        endDate={endDate}
        targetId={targetId}
      />
      <OutboundTopBoards
        result={itemTop}
        dayBoard={outboundDay}
        day={day}
        onDayChange={onDayChange}
        busy={busy}
        startDate={startDate}
        endDate={endDate}
        targetId={targetId}
      />
    </>
  );
  return isMobile ? (
    <div className="space-y-4 px-4">{boards}</div>
  ) : (
    <div className="space-y-5 md:col-span-2">{boards}</div>
  );
}
