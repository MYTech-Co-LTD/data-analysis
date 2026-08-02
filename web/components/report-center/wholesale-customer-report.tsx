"use client";

// 批发客户报表：3120 客户排名 + 品品甜 KPI 卡 + 高亮品品甜客户行。
// 数据走 server 预取（WholesaleCustomerResult 解构为 4 props）。
// DESIGN.md：tabular-nums + chart-actions 三动作 + 警示琥珀高亮（品品甜行）。
import { useRef } from "react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import type { WholesaleCustomerRow } from "@/lib/report-center/wholesale-customer";

function fmtWan(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

interface WholesaleCustomerReportProps {
  rows: WholesaleCustomerRow[];
  /** 品品甜客户批发合计 */
  pinpintianAmount: number;
  /** 品品甜占 3120 总额比例（0-1） */
  pinpintianPct: number;
  /** 3120 客户批发总额 */
  total3120: number;
}

export function WholesaleCustomerReport({
  rows,
  pinpintianAmount,
  pinpintianPct,
  total3120,
}: WholesaleCustomerReportProps) {
  const tableRef = useRef<HTMLDivElement>(null);

  const handleExcel = () => {
    const head = ["客户", "金额", "占比", "累计占比", "品品甜"];
    const body = rows.map((r) => [
      r.client_name,
      r.wholesale_amount,
      fmtPct(r.pct),
      fmtPct(r.cumulative_pct),
      r.is_pinpintian ? "是" : "",
    ]);
    exportExcel([head, ...body], "批发客户3120");
  };

  const handleImage = () => {
    if (tableRef.current) exportImage(tableRef.current, "批发客户报表");
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
        <h3 className="text-sm font-medium text-slate-700">批发客户报表（3120）</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
      </div>

      {/* KPI 横条：品品甜占 3120 批发 + 3120 批发总额 */}
      <div className="mb-3 flex items-center gap-4 rounded bg-blue-50 p-3 text-sm">
        <div>
          <div className="text-xs text-slate-500">品品甜占 3120 批发</div>
          <div className="font-bold tabular-nums text-blue-700">
            {fmtWan(pinpintianAmount)} · {fmtPct(pinpintianPct)}
          </div>
        </div>
        <div className="text-slate-300">|</div>
        <div>
          <div className="text-xs text-slate-500">3120 批发总额</div>
          <div className="font-medium tabular-nums text-slate-700">{fmtWan(total3120)}</div>
        </div>
      </div>

      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500">
              <th className="border border-slate-200 p-2 text-left font-medium">客户</th>
              <th className="border border-slate-200 p-2 text-right font-medium">金额</th>
              <th className="border border-slate-200 p-2 text-right font-medium">占比</th>
              <th className="border border-slate-200 p-2 text-right font-medium">累计</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="border border-slate-200 p-4 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.client_code} className={r.is_pinpintian ? "bg-amber-50" : "hover:bg-slate-50"}>
                  <td className="border border-slate-200 p-2 text-slate-700">
                    {r.client_name}
                    {r.is_pinpintian && (
                      <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                        品品甜
                      </span>
                    )}
                  </td>
                  <td className="border border-slate-200 p-2 text-right font-medium text-slate-800">
                    {fmtWan(r.wholesale_amount)}
                  </td>
                  <td className="border border-slate-200 p-2 text-right text-slate-700">
                    {fmtPct(r.pct)}
                  </td>
                  <td className="border border-slate-200 p-2 text-right text-slate-500">
                    {fmtPct(r.cumulative_pct)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
