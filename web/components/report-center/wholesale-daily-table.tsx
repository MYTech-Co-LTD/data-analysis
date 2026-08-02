"use client";

// 外部批发客户出库日报（按 biz_date 升序）。
// 数据：WholesaleDailyRow[]（wholesale_ext = 3120 熊喵除品品甜外的外部批发客户）。
// 4 列：时间 / 出库金额 / 出库毛利 / 毛利率 + 末行合计。
// 标红：wholesale_ext_margin < 0（负毛利亏损）整行标红。
// 脱敏：profit/margin 为 NULL 显示「-」；margin 是 0-1 小数（×100 显示百分比）。
// DESIGN.md：tabular-nums + 类 Excel 交叉表 + chart-actions 三动作。
import { useMemo, useRef } from "react";
import type { WholesaleDailyRow } from "@/lib/report-center/wholesale-daily";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";

interface WholesaleDailyTableProps {
  rows: WholesaleDailyRow[];
  startDate: string;
  endDate: string;
}

// 金额格式化：≥10000 用「X.X万」，否则整数，¥ 前缀（与 item-top-boards 对齐）
function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}
// 利润格式化：NULL 脱敏显示「-」，否则 fmtCurrency（负数亏损正常显示）
function fmtProfit(v: number | null): string {
  return v == null ? "-" : fmtCurrency(v);
}
// 毛利率：NULL 脱敏「-」，否则 ×100 保留 1 位 + %
function fmtMargin(m: number | null): string {
  return m == null ? "-" : `${(m * 100).toFixed(1)}%`;
}
// 标题命名：{sM}月{sD}日-{eM}月{eD}日{suffix}
function fmtRangeTitle(start: string, end: string, suffix: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日${suffix}`;
}

export function WholesaleDailyTable({
  rows,
  startDate,
  endDate,
}: WholesaleDailyTableProps) {
  const tableRef = useRef<HTMLDivElement>(null);

  // 末行合计：SUM amount/profit，margin = 合计 profit / 合计 amount（前端算）
  // profit 全脱敏（无任何非 NULL 行）时显示「-」
  const totals = useMemo(() => {
    let amount = 0;
    let profitSum = 0;
    let hasProfit = false;
    for (const r of rows) {
      amount += r.wholesale_ext_amount;
      if (r.wholesale_ext_profit != null) {
        profitSum += r.wholesale_ext_profit;
        hasProfit = true;
      }
    }
    const profit = hasProfit ? profitSum : null;
    return {
      amount,
      profit,
      margin: amount > 0 && profit != null ? profit / amount : null,
    };
  }, [rows]);

  const title = fmtRangeTitle(startDate, endDate, "外部批发客户出库报表");

  const handleExcel = () => {
    const head = ["时间", "出库金额", "出库毛利", "毛利率"];
    const body: (string | number)[][] = rows.map((r) => [
      r.biz_date,
      r.wholesale_ext_amount,
      r.wholesale_ext_profit ?? "",
      r.wholesale_ext_margin != null ? fmtMargin(r.wholesale_ext_margin) : "",
    ]);
    body.push([
      "合计",
      totals.amount,
      totals.profit ?? "",
      totals.margin != null ? fmtMargin(totals.margin) : "",
    ]);
    exportExcel([head, ...body], title);
  };

  const handleImage = () => {
    if (tableRef.current) exportImage(tableRef.current, title);
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
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
      </div>
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">时间</th>
              <th className="px-3 py-2 text-right font-medium">出库金额</th>
              <th className="px-3 py-2 text-right font-medium">出库毛利</th>
              <th className="px-3 py-2 text-right font-medium">毛利率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const lowMargin =
                r.wholesale_ext_margin != null && r.wholesale_ext_margin < 0;
              const rowBg = lowMargin ? "bg-red-50" : "hover:bg-slate-50";
              const numColor = lowMargin ? "text-red-600" : "text-slate-700";
              return (
                <tr key={r.biz_date} className={rowBg}>
                  <td className="px-3 py-2 text-left text-slate-700">{r.biz_date}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                    {fmtCurrency(r.wholesale_ext_amount)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                    {fmtProfit(r.wholesale_ext_profit)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                    {fmtMargin(r.wholesale_ext_margin)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
              <td className="px-3 py-2 text-left">合计</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtCurrency(totals.amount)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtProfit(totals.profit)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtMargin(totals.margin)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
