"use client";

import { useRef } from "react";
import { BrandMetricRow } from "@/lib/report-center/brand-metric";
import type { GetterResult } from "@/lib/report-center/types";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { MaskedBadge } from "./masked-badge";
import { ModuleError } from "./module-error";
import { useCanSeeCost } from "./use-can-see-cost";

interface BrandMetricTableProps {
  result: GetterResult<BrandMetricRow>;
  targetMonth?: number;
  isMobile?: boolean;
}

// 金额万化（≥10000 → X.X万 else 整数），¥ 前缀；NULL → "—"
function fmtCurrency(v: number | null): string {
  if (v == null) return "—";
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

// 率（×100, 1 位小数）；NULL → "—"
function fmtRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

// 达成率三色（照 kpi-cards.rateColor）：≥1 绿/≥0.8 琥珀/<0.8 红；NULL → 灰
function rateColor(r: number | null): string {
  if (r == null) return "text-slate-300";
  return r >= 1
    ? "text-green-600"
    : r >= 0.8
      ? "text-amber-600"
      : "text-red-600";
}

// 品牌×指标表：3 行（熊喵/品品甜/合计）。完成率三色，合计行高亮。
// 镜像 category-summary.tsx 结构/样式 + chart-actions 导出。
export function BrandMetricTable({ result, targetMonth, isMobile = false }: BrandMetricTableProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);
  const title = `${targetMonth ?? ""}月品牌×指标`;
  // F2.3: can_see_cost=false 时 profit/margin 列头挂脱敏角标（NULL 透传由 fmtCurrency/fmtRate 兜「—」）
  const costMasked = !useCanSeeCost();

  const handleExcel = () => {
    const head = [
      "品牌",
      "销售目标",
      "销售金额",
      "销售完成率",
      "配送金额",
      "配送毛利",
      "配送毛利率",
    ];
    const body = rows.map((r) => [
      r.system_book_code === "合计"
        ? "合计"
        : (r.brand_name ?? r.system_book_code),
      r.sale_target,
      r.sale_amount,
      r.sale_rate == null ? "—" : `${(r.sale_rate * 100).toFixed(1)}%`,
      r.delivery_amount,
      r.delivery_profit == null ? "—" : r.delivery_profit,
      r.delivery_margin == null ? "—" : `${(r.delivery_margin * 100).toFixed(1)}%`,
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
    } catch {}
  };

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={`品牌×指标加载失败${error?.message ? `（${error.message}）` : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <ChartActions
          onExcel={handleExcel}
          onImage={handleImage}
          onShare={handleShare}
          isMobile={isMobile}
        />
      </div>
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr className="sticky top-0 z-10 bg-slate-50">
              <th className="px-3 py-2 text-left font-medium">品牌</th>
              <th className="px-3 py-2 text-right font-medium">销售目标</th>
              <th className="px-3 py-2 text-right font-medium">销售金额</th>
              <th className="px-3 py-2 text-right font-medium">销售完成率</th>
              <th className="px-3 py-2 text-right font-medium">配送金额</th>
              <th className="px-3 py-2 text-right font-medium">
                配送毛利{costMasked && <MaskedBadge />}
              </th>
              <th className="px-3 py-2 text-right font-medium">
                配送毛利率{costMasked && <MaskedBadge />}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  暂无品牌数据
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isTotal = r.system_book_code === "合计";
              const brandCell = isTotal
                ? "合计"
                : (r.brand_name ?? r.system_book_code);
              return (
                <tr
                  key={`${r.target_id}-${r.system_book_code}`}
                  className={isTotal ? "bg-slate-50 font-medium" : "hover:bg-slate-50"}
                >
                  <td className="px-3 py-2 text-slate-700">{brandCell}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCurrency(r.sale_target)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCurrency(r.sale_amount)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${rateColor(
                      r.sale_rate
                    )}`}
                  >
                    {fmtRate(r.sale_rate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCurrency(r.delivery_amount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCurrency(r.delivery_profit)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtRate(r.delivery_margin)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
