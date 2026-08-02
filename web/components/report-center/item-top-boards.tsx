"use client";

// 商品 TOP 榜（销售/出库 × 月/日，2×2 网格）+ 日期选择器 + 点入弹层。
// 月榜走 server 预取（ItemBreakdownTop）；日榜切换走 /api/admin/reports/item-top。
// DESIGN.md：tabular-nums + 达成三色编码（占比≥10% 蓝/5-10% 琥珀/<5% 灰）+ chart-actions 三动作。
import { useRef, useState } from "react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { ItemDetailDrawer } from "./item-detail-drawer";
import type { ItemBreakdownTop, ItemTopRow } from "@/lib/report-center/item-breakdown";

// 占比三色：>10% 蓝（重点商品）/ 5-10% 琥珀（次重点）/ <5% 灰（长尾）
function pctColor(pct: number): string {
  if (pct >= 0.1) return "text-blue-600";
  if (pct >= 0.05) return "text-amber-600";
  return "text-slate-400";
}

// 金额格式化：≥10000 用「X.X万」，否则整数，¥ 前缀
function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

// 单列 TOP 榜：序号 + 名称 + 金额 + 占比（三色）；行点击触发弹层。
function TopList({ rows, onPick }: { rows: ItemTopRow[]; onPick: (code: string) => void }) {
  if (rows.length === 0) {
    return <div className="py-4 text-center text-xs text-slate-400">暂无数据</div>;
  }
  return (
    <ol className="text-sm tabular-nums">
      {rows.map((r, i) => (
        <li
          key={r.item_code}
          className="flex cursor-pointer items-center gap-2 py-1 hover:bg-slate-50"
          onClick={() => onPick(r.item_code)}
        >
          <span className="w-6 shrink-0 text-slate-400">{i + 1}</span>
          <span className="flex-1 truncate text-slate-700" title={r.item_name}>
            {r.item_name}
          </span>
          <span className="font-medium text-slate-800">{fmtCurrency(r.amount)}</span>
          <span className={`w-12 shrink-0 text-right text-xs ${pctColor(r.pct)}`}>
            {fmtPct(r.pct)}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface ItemTopBoardsProps {
  top: ItemBreakdownTop;
  targetId: number;
}

export function ItemTopBoards({ top, targetId }: ItemTopBoardsProps) {
  const boardsRef = useRef<HTMLDivElement>(null);
  const [day, setDay] = useState<string>(top.defaultDay);
  const [dayData, setDayData] = useState<{ sale: ItemTopRow[]; outbound: ItemTopRow[] }>({
    sale: top.saleDay,
    outbound: top.outboundDay,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);

  // 切日：并行请求 sale + outbound 日榜
  const onDayChange = async (d: string) => {
    if (!d || d === day) return;
    setDay(d);
    setBusy(true);
    setError(null);
    try {
      const [sRes, oRes] = await Promise.all([
        fetch("/api/admin/reports/item-top", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_id: targetId, date: d, metric: "sale" }),
        }).then((r) => r.json()),
        fetch("/api/admin/reports/item-top", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_id: targetId, date: d, metric: "outbound" }),
        }).then((r) => r.json()),
      ]);
      setDayData({
        sale: Array.isArray(sRes?.rows) ? sRes.rows : [],
        outbound: Array.isArray(oRes?.rows) ? oRes.rows : [],
      });
    } catch (e) {
      setError("日榜加载失败");
    } finally {
      setBusy(false);
    }
  };

  const handleExcel = () => {
    const head = ["排名", "商品", "金额", "占比"];
    const saleMonthBody = top.saleMonth.map((r, i) => [
      i + 1,
      r.item_name,
      r.amount,
      fmtPct(r.pct),
    ]);
    exportExcel([["销售月榜", ...head.slice(1)], ...saleMonthBody], "商品TOP销售月榜");
  };

  const handleImage = () => {
    if (boardsRef.current) exportImage(boardsRef.current, "商品TOP榜");
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

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">商品 TOP 榜</h3>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <span>日榜日期</span>
            <input
              type="date"
              value={day}
              onChange={(e) => onDayChange(e.target.value)}
              className="rounded border border-slate-200 px-2 py-0.5 text-xs tabular-nums focus:border-blue-500 focus:outline-none"
            />
          </label>
          <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
        </div>
      </div>

      <div ref={boardsRef} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-slate-500">销售月榜</div>
          <TopList rows={top.saleMonth} onPick={setDrawer} />
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">
            销售日榜{day ? `（${day}）` : ""}
            {busy && <span className="ml-1 text-slate-400">加载中…</span>}
          </div>
          <TopList rows={dayData.sale} onPick={setDrawer} />
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">出库月榜</div>
          <TopList rows={top.outboundMonth} onPick={setDrawer} />
        </div>
        <div>
          <div className="mb-1 text-xs text-slate-500">
            出库日榜{day ? `（${day}）` : ""}
            {busy && <span className="ml-1 text-slate-400">加载中…</span>}
          </div>
          <TopList rows={dayData.outbound} onPick={setDrawer} />
        </div>
      </div>

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

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
