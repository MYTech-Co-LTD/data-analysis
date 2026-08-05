"use client";

// 商品 TOP 4 独立看板：销售组（月度+日）+ 出库组（月度+日）。
// 每看板独立卡片：表头 + TOP20 + 3 行合计（TOP20小计/总合计/占比）。
// 命名：月榜用目标日期范围（{startM}月{startD}日-{endM}月{endD}日），日榜用选中日（{M}月{D}号/日）。
// 销售看板 5 列（序号/商品/金额/毛利/毛利率），出库看板 5 列（同构）。
// 日榜日期选择器放日榜卡片标题旁，销售/出库共用 day state（改一个两个都变）。
// DESIGN.md：tabular-nums + 类 Excel 交叉表 + chart-actions 三动作 + 点商品弹详情抽屉。
import { useRef, useState } from "react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { ItemDetailDrawer } from "./item-detail-drawer";
import { ModuleError } from "./module-error";
import type { TopBoard, ItemBreakdownResult } from "@/lib/report-center/item-breakdown";

// 金额格式化：≥10000 用「X.X万」，否则整数，¥ 前缀
function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}
// 利润格式化：null/0/负数均显示「-」（脱敏 NULL 透传，与无成本权限一致不露成本）
function fmtProfit(v: number | null | undefined): string {
  return v != null && v > 0 ? fmtCurrency(v) : "-";
}
function fmtPct(p: number | null | undefined): string {
  return p != null ? `${(p * 100).toFixed(1)}%` : "-";
}
// 毛利率：金额或毛利为 0/NULL 显示「-」
function fmtMargin(profit: number | null | undefined, amount: number): string {
  return amount > 0 && profit != null && profit > 0 ? fmtPct(profit / amount) : "-";
}

// 月榜命名：{startM}月{startD}日-{endM}月{endD}日{suffix}
function fmtRangeTitle(start: string, end: string, suffix: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日${suffix}`;
}
// 日榜命名：{M}月{D}{号|日}{suffix}
function fmtDayTitle(day: string, suffix: string, dayWord: "号" | "日"): string {
  const d = new Date(day);
  return `${d.getMonth() + 1}月${d.getDate()}${dayWord}${suffix}`;
}

// 列定义
type ColKey = "idx" | "item_name" | "amount" | "profit" | "margin";
interface ColDef {
  key: ColKey;
  label: string;
  align: "left" | "right";
  width?: string;
}
const SALE_COLS: ColDef[] = [
  { key: "idx", label: "序号", align: "left", width: "w-8" },
  { key: "item_name", label: "商品名称", align: "left" },
  { key: "amount", label: "销售金额", align: "right" },
  { key: "profit", label: "销售毛利", align: "right" },
  { key: "margin", label: "毛利率", align: "right" },
];
const OUTBOUND_COLS: ColDef[] = [
  { key: "idx", label: "序号", align: "left", width: "w-8" },
  { key: "item_name", label: "商品名称", align: "left" },
  { key: "amount", label: "出库金额", align: "right" },
  { key: "profit", label: "出库毛利", align: "right" },
  { key: "margin", label: "毛利率", align: "right" },
];

// 单元格值
function cellText(
  row: { item_name: string; amount: number; profit: number | null },
  key: ColKey,
  idx: number,
): string {
  switch (key) {
    case "idx":
      return String(idx + 1);
    case "item_name":
      return row.item_name;
    case "amount":
      return fmtCurrency(row.amount);
    case "profit":
      return fmtProfit(row.profit);
    case "margin":
      return fmtMargin(row.profit, row.amount);
  }
}

/**
 * 单个 TOP 看板卡片：表头 + TOP20 + 3 行合计。
 * 合计：TOP20小计 / 总合计 / TOP20占比（金额占比 + 毛利占比）。
 */
function TopBoardCard({
  title,
  board,
  columns,
  onPick,
  busy,
  dateInput,
}: {
  title: string;
  board: TopBoard;
  columns: ColDef[];
  onPick: (code: string) => void;
  busy?: boolean;
  dateInput?: React.ReactNode;
}) {
  // F2.4: 脱敏利润透传。TOP20 全脱敏（profit=null）-> top20Profit=null（不当 0 累加，
  // 与 toBoard 的 totalProfit 语义一致）；部分脱敏 -> 只累加非 null 行。
  const top20Amount = board.rows.reduce((s, r) => s + r.amount, 0);
  const top20Profit: number | null = board.rows.every((r) => r.profit == null)
    ? null
    : board.rows.reduce((s, r) => s + (r.profit ?? 0), 0);
  const { totalAmount, totalProfit } = board;
  const amountPct = totalAmount > 0 ? top20Amount / totalAmount : 0;
  // totalProfit=null（全脱敏）或 top20Profit=null（TOP20 全脱敏）-> profitPct=null（显示「-」），
  // 否则按原口径（totalProfit>0 才算占比，避免除 0）。
  const profitPct: number | null =
    totalProfit == null || top20Profit == null
      ? null
      : totalProfit > 0
        ? top20Profit / totalProfit
        : 0;

  // 合计行单元格
  const summaryCell = (key: ColKey): string => {
    switch (key) {
      case "idx":
        return "";
      case "item_name":
        return "";
      case "amount":
        return fmtCurrency(top20Amount);
      case "profit":
        return fmtProfit(top20Profit);
      case "margin":
        return fmtMargin(top20Profit, top20Amount);
    }
  };
  const totalCell = (key: ColKey): string => {
    switch (key) {
      case "idx":
        return "";
      case "item_name":
        return "";
      case "amount":
        return fmtCurrency(totalAmount);
      case "profit":
        return fmtProfit(totalProfit);
      case "margin":
        return fmtMargin(totalProfit, totalAmount);
    }
  };
  const pctCell = (key: ColKey): string => {
    switch (key) {
      case "idx":
        return "";
      case "item_name":
        return "";
      case "amount":
        return fmtPct(amountPct);
      case "profit":
        return fmtPct(profitPct);
      case "margin":
        return "";
    }
  };

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="text-xs font-medium text-slate-700">{title}</span>
        {busy && <span className="text-[10px] text-slate-400">加载中…</span>}
        {dateInput}
      </div>
      {board.rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-slate-400">暂无数据</div>
      ) : (
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50 text-[11px] text-slate-500">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-2 py-1.5 font-medium ${c.align === "right" ? "text-right" : "text-left"} ${c.width ?? ""}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((r, i) => (
              <tr
                key={r.item_code}
                className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                onClick={() => onPick(r.item_code)}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-2 py-1 ${c.align === "right" ? "text-right" : "text-left"} ${c.key === "item_name" ? "max-w-[10rem] truncate" : ""} ${c.key === "amount" ? "font-medium text-slate-800" : "text-slate-600"}`}
                    title={c.key === "item_name" ? r.item_name : undefined}
                  >
                    {cellText(r, c.key, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-1 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  {c.key === "item_name" ? "TOP20小计" : summaryCell(c.key)}
                </td>
              ))}
            </tr>
            <tr className="border-t border-slate-50 bg-slate-50/50 font-medium text-slate-800">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-1 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  {c.key === "item_name" ? "总合计" : totalCell(c.key)}
                </td>
              ))}
            </tr>
            <tr className="border-t border-slate-50 bg-blue-50/40 text-blue-700">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-1 ${c.align === "right" ? "text-right" : "text-left"}`}
                >
                  {c.key === "item_name" ? "TOP20占比" : pctCell(c.key)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

// 日期选择器（日榜卡片标题旁）
function DayPicker({
  day,
  onDayChange,
}: {
  day: string;
  onDayChange: (d: string) => void;
}) {
  return (
    <input
      type="date"
      value={day}
      onChange={(e) => onDayChange(e.target.value)}
      className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] tabular-nums focus:border-blue-500 focus:outline-none"
    />
  );
}

/**
 * 日榜切换 hook：销售/出库共用 day state，切日并行请求两个 metric。
 * 返回 { day, saleDay, outboundDay, onDayChange, busy, error }。
 */
export function useItemDayBoards(
  targetId: number,
  defaultDay: string,
  initialSale: TopBoard,
  initialOutbound: TopBoard,
) {
  const [day, setDay] = useState(defaultDay);
  const [boards, setBoards] = useState<{ sale: TopBoard; outbound: TopBoard }>({
    sale: initialSale,
    outbound: initialOutbound,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 切日竞态防护：快速切日时 abort 上一次请求，避免旧响应覆盖新。
  const ctrlRef = useRef<AbortController | null>(null);

  const onDayChange = async (d: string) => {
    if (!d || d === day) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setDay(d);
    setBusy(true);
    setError(null);
    try {
      const [sRes, oRes] = await Promise.all([
        fetch("/api/admin/reports/item-top", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_id: targetId, date: d, metric: "sale" }),
          signal: ctrl.signal,
        }).then((r) => r.json()),
        fetch("/api/admin/reports/item-top", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target_id: targetId,
            date: d,
            metric: "outbound",
          }),
          signal: ctrl.signal,
        }).then((r) => r.json()),
      ]);
      setBoards({
        sale:
          sRes?.board ?? { rows: [], totalAmount: 0, totalProfit: null },
        outbound:
          oRes?.board ?? { rows: [], totalAmount: 0, totalProfit: null },
      });
    } catch (e) {
      // 取消的请求静默退出，不报错也不清 busy（busy 由 finally 守卫）
      if ((e as Error).name === "AbortError") return;
      setError("日榜加载失败");
    } finally {
      // 仅当本次请求未被 abort 时才清 busy，避免被后续 abort 的请求提前清掉
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };

  return { day, saleDay: boards.sale, outboundDay: boards.outbound, onDayChange, busy, error };
}

/** 销售商品 TOP 组：月度 + 日（2 列并排），日榜带日期选择器 */
export function SaleTopBoards({
  result,
  dayBoard,
  day,
  onDayChange,
  busy,
  startDate,
  endDate,
  targetId,
}: {
  result: ItemBreakdownResult;
  dayBoard: TopBoard;
  day: string;
  onDayChange: (d: string) => void;
  busy: boolean;
  startDate: string;
  endDate: string;
  targetId: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const monthBoard = result.saleMonth;
  const { status, error } = result;

  const handleExcel = () => {
    const head = ["排名", "商品", "金额", "毛利", "毛利率"];
    const monthBody = monthBoard.rows.map((r, i) => [
      i + 1,
      r.item_name,
      r.amount,
      // 脱敏 profit=null -> 导出 0（Excel 不接受 null；与显示「-」语义一致：无可视毛利）
      r.profit ?? 0,
      r.amount > 0 && r.profit != null && r.profit > 0
        ? fmtPct(r.profit / r.amount)
        : "-",
    ]);
    exportExcel(
      [
        ["销售月榜", ...head.slice(1)],
        ...monthBody,
      ],
      "销售商品TOP榜",
    );
  };
  const handleImage = () => {
    if (ref.current) exportImage(ref.current, "销售商品TOP榜");
  };
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const { toast } = await import("sonner");
      toast.success("链接已复制");
    } catch {
      /* clipboard 拒绝时静默 */
    }
  };

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4" ref={ref}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">销售商品 TOP 榜</h3>
        </div>
        <ModuleError
          message={`销售商品榜加载失败${error?.message ? `（${error.message}）` : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4" ref={ref}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">销售商品 TOP 榜</h3>
        <ChartActions
          onExcel={handleExcel}
          onImage={handleImage}
          onShare={handleShare}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TopBoardCard
          title={fmtRangeTitle(startDate, endDate, "销售商品TOP20")}
          board={monthBoard}
          columns={SALE_COLS}
          onPick={setDrawer}
        />
        <TopBoardCard
          title={fmtDayTitle(day, "销售商品TOP20", "号")}
          board={dayBoard}
          columns={SALE_COLS}
          onPick={setDrawer}
          busy={busy}
          dateInput={<DayPicker day={day} onDayChange={onDayChange} />}
        />
      </div>
      {drawer && (
        <ItemDetailDrawer
          itemCode={drawer}
          targetId={targetId}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

/** 出库商品 TOP 组：月度 + 日（2 列并排），日榜带日期选择器 */
export function OutboundTopBoards({
  result,
  dayBoard,
  day,
  onDayChange,
  busy,
  startDate,
  endDate,
  targetId,
}: {
  result: ItemBreakdownResult;
  dayBoard: TopBoard;
  day: string;
  onDayChange: (d: string) => void;
  busy: boolean;
  startDate: string;
  endDate: string;
  targetId: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const monthBoard = result.outboundMonth;
  const { status, error } = result;

  const handleExcel = () => {
    const head = ["排名", "商品", "金额", "毛利", "毛利率"];
    const monthBody = monthBoard.rows.map((r, i) => [
      i + 1,
      r.item_name,
      r.amount,
      // 脱敏 profit=null -> 导出 0（Excel 不接受 null；与显示「-」语义一致）
      r.profit ?? 0,
      r.amount > 0 && r.profit != null && r.profit > 0
        ? fmtPct(r.profit / r.amount)
        : "-",
    ]);
    exportExcel(
      [
        ["出库月榜", ...head.slice(1)],
        ...monthBody,
      ],
      "出库商品TOP榜",
    );
  };
  const handleImage = () => {
    if (ref.current) exportImage(ref.current, "出库商品TOP榜");
  };
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const { toast } = await import("sonner");
      toast.success("链接已复制");
    } catch {
      /* clipboard 拒绝时静默 */
    }
  };

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4" ref={ref}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">出库商品 TOP 榜</h3>
        </div>
        <ModuleError
          message={`出库商品榜加载失败${error?.message ? `（${error.message}）` : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4" ref={ref}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">出库商品 TOP 榜</h3>
        <ChartActions
          onExcel={handleExcel}
          onImage={handleImage}
          onShare={handleShare}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TopBoardCard
          title={fmtRangeTitle(startDate, endDate, "出库商品TOP20")}
          board={monthBoard}
          columns={OUTBOUND_COLS}
          onPick={setDrawer}
        />
        <TopBoardCard
          title={fmtDayTitle(day, "出库商品TOP20", "日")}
          board={dayBoard}
          columns={OUTBOUND_COLS}
          onPick={setDrawer}
          busy={busy}
          dateInput={<DayPicker day={day} onDayChange={onDayChange} />}
        />
      </div>
      {drawer && (
        <ItemDetailDrawer
          itemCode={drawer}
          targetId={targetId}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
