"use client";

import { useRef } from "react";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";

interface CategorySummaryProps {
  rows: CategorySummaryRow[];
  targetMonth: number;
}

// 毛利率 < 12% 标红
function marginColor(margin: number | null): string {
  if (margin == null) return "text-slate-300";
  return margin < 0.12 ? "text-red-600" : "text-slate-700";
}

function fmtCurrency(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

export function CategorySummary({ rows, targetMonth }: CategorySummaryProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const handleExcel = () => {
    const head = [
      "类别", "月销售目标", "月销售金额", "月销售完成率",
      "月毛利目标", "月毛利金额", "月毛利完成率", "月毛利率",
      "当天出库金额", "当天出库毛利", "当天毛利率", "差额日均毛利目标",
    ];
    const body = rows.map((r) => [
      r.category,
      r.sale_target, r.sale_actual, fmtRate(r.sale_rate),
      r.profit_target, r.profit_actual, fmtRate(r.profit_rate), fmtRate(r.profit_margin),
      r.daily_amount, r.daily_profit, fmtRate(r.daily_profit_margin),
      r.remaining_daily_profit_target,
    ]);
    exportExcel([head, ...body], `${targetMonth}月仓储出库数据报表`);
  };

  const handleImage = () => {
    if (tableRef.current) exportImage(tableRef.current, `${targetMonth}月仓储出库报表`);
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const { toast } = await import("sonner");
      toast.success("链接已复制");
    } catch {}
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {targetMonth}月仓储出库数据报表
        </h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
      </div>
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">类别</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利率</th>
              <th className="px-3 py-2 text-right font-medium"> 当天出库金额</th>
              <th className="px-3 py-2 text-right font-medium"> 当天出库毛利</th>
              <th className="px-3 py-2 text-right font-medium"> 当天毛利率</th>
              <th className="px-3 py-2 text-right font-medium"> 差额日均毛利目标</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.category} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-700 font-medium">
                  {r.category}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.sale_target)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.sale_actual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtRate(r.sale_rate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.profit_target)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.profit_actual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtRate(r.profit_rate)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(r.profit_margin)}`}>
                  {fmtRate(r.profit_margin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.daily_amount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.daily_profit)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(r.daily_profit_margin)}`}>
                  {fmtRate(r.daily_profit_margin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.remaining_daily_profit_target)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
