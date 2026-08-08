"use client";

import { useMemo, useRef } from "react";
import { BrandMetricRow } from "@/lib/report-center/brand-metric";
import type { GetterResult } from "@/lib/report-center/types";
import {
  isSuspiciousAmount,
  isSuspiciousProfit,
  isSuspiciousRate,
  isSuspiciousMargin,
  suspiciousClass,
  suspiciousTitle,
  amountsClose,
  ratesClose,
  numMatch,
  sumField,
  sumNullable,
} from "@/lib/report-center/guard";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { TotalAnomalyBadge } from "./data-guard-badges";
import { MaskedBadge } from "./masked-badge";
import { ModuleError, formatModuleError } from "./module-error";
import { useCanSeeCost } from "./use-can-see-cost";
import { actualRatio, formatRatio, marginAchievement, absoluteThreeColor } from "@/lib/report-center/ratio";

interface BrandMetricTableProps {
  result: GetterResult<BrandMetricRow>;
  targetMonth?: number;
  progress?: number; // 时间进度（如 0.677）；传了则达成率按「达成率/时间进度」相对着色
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

// 达成率三色（对齐 KPI 比率带）：按「达成率 / 时间进度」对比着色（相对进度）：
//   >=1   → success #16A34A（跑赢进度）
//   >=0.8 → warning #D97706（接近）
//   <0.8  → error #DC2626（落后）
// progress 未传（null/undefined）→ 退化为绝对达成率三色（rate 本身）；progress=0 → 除 0.0001 兜底。
// NULL rate → 灰（无数据/脱敏）。
function rateColor(r: number | null, progress?: number): string {
  if (r == null) return "text-slate-300";
  const ratio = progress == null ? r : r / (progress || 0.0001);
  return ratio >= 1
    ? "text-green-600"
    : ratio >= 0.8
      ? "text-amber-600"
      : "text-red-600";
}

// 品牌×指标表：3 行（熊喵/品品甜/合计）。完成率三色，合计行高亮。
// 镜像 category-summary.tsx 结构/样式 + chart-actions 导出。
export function BrandMetricTable({ result, targetMonth, progress, isMobile = false }: BrandMetricTableProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);
  const title = `${targetMonth ?? ""}月品牌×指标`;
  // F2.3: can_see_cost=false 时 profit/margin 列头挂脱敏角标（NULL 透传由 fmtCurrency/fmtRate 兜「—」）
  const costMasked = !useCanSeeCost();

  // F3 合计自洽：前端重算非「合计」行 SUM vs 视图 system_book_code='合计' 行，不一致 → 角标
  const detailRows = useMemo(
    () => rows.filter((r) => r.system_book_code !== "合计"),
    [rows],
  );
  const frontTotals = useMemo(() => {
    const saleTarget = sumField(detailRows, (r) => r.sale_target);
    const saleAmount = sumField(detailRows, (r) => r.sale_amount);
    const deliveryAmount = sumField(detailRows, (r) => r.delivery_amount);
    const deliveryProfit = sumNullable(detailRows, (r) => r.delivery_profit);
    return {
      saleTarget,
      saleAmount,
      deliveryAmount,
      deliveryProfit,
      saleRate: saleTarget > 0 ? saleAmount / saleTarget : null,
      deliveryMargin:
        deliveryAmount > 0 && deliveryProfit != null
          ? deliveryProfit / deliveryAmount
          : null,
      deliverySaleRatio: saleAmount > 0 ? deliveryAmount / saleAmount : null,
    };
  }, [detailRows]);
  const totalAnomaly = useMemo(() => {
    const vr = rows.find((r) => r.system_book_code === "合计");
    if (!vr || detailRows.length === 0) return false;
    return !(
      numMatch(frontTotals.saleTarget, vr.sale_target, 1, amountsClose) &&
      numMatch(frontTotals.saleAmount, vr.sale_amount, 1, amountsClose) &&
      numMatch(frontTotals.deliveryAmount, vr.delivery_amount, 1, amountsClose) &&
      numMatch(frontTotals.deliveryProfit, vr.delivery_profit, 1, amountsClose) &&
      numMatch(frontTotals.saleRate, vr.sale_rate, 1e-3, ratesClose) &&
      numMatch(frontTotals.deliveryMargin, vr.delivery_margin, 1e-3, ratesClose) &&
      numMatch(
        frontTotals.deliverySaleRatio,
        vr.sale_amount > 0 ? vr.delivery_amount / vr.sale_amount : null,
        1e-3,
        ratesClose,
      )
    );
  }, [rows, detailRows, frontTotals]);

  const handleExcel = () => {
    const head = [
      "品牌",
      "销售目标",
      "销售金额",
      "销售完成率",
      "配送金额",
      "配销比",
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
      formatRatio(actualRatio(r.delivery_amount, r.sale_amount)),
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
          message={formatModuleError("品牌×指标加载失败", error)}
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
              <th className="px-3 py-2 text-right font-medium">配销比</th>
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
                <td colSpan={8} className="px-3 py-8 text-center text-slate-400">
                  暂无品牌数据
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isTotal = r.system_book_code === "合计";
              const brandCell = isTotal
                ? "合计"
                : (r.brand_name ?? r.system_book_code);
              // F4: 该行各字段是否「可疑」
              const s = {
                saleTarget: isSuspiciousAmount(r.sale_target),
                saleAmount: isSuspiciousAmount(r.sale_amount),
                saleRate: isSuspiciousRate(r.sale_rate),
                deliveryAmount: isSuspiciousAmount(r.delivery_amount),
                deliveryProfit: isSuspiciousProfit(r.delivery_profit),
                deliveryMargin: isSuspiciousMargin(r.delivery_margin),
              };
              return (
                <tr
                  key={`${r.target_id}-${r.system_book_code}`}
                  className={isTotal ? "bg-slate-50 font-medium" : "hover:bg-slate-50"}
                >
                  <td className="px-3 py-2 text-slate-700">
                    {brandCell}
                    {isTotal && totalAnomaly && <TotalAnomalyBadge />}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleTarget, "text-slate-700")}`} title={suspiciousTitle(s.saleTarget)}>
                    {fmtCurrency(r.sale_target)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleAmount, "text-slate-700")}`} title={suspiciousTitle(s.saleAmount)}>
                    {fmtCurrency(r.sale_amount)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(
                      s.saleRate,
                      rateColor(r.sale_rate, progress)
                    )}`}
                    title={suspiciousTitle(s.saleRate)}
                  >
                    {fmtRate(r.sale_rate)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryAmount, "text-slate-700")}`} title={suspiciousTitle(s.deliveryAmount)}>
                    {fmtCurrency(r.delivery_amount)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousMargin(actualRatio(r.delivery_amount, r.sale_amount)), "text-slate-700")}`} title={suspiciousTitle(isSuspiciousMargin(actualRatio(r.delivery_amount, r.sale_amount)))}>
                    {formatRatio(actualRatio(r.delivery_amount, r.sale_amount))}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryProfit, "text-slate-700")}`} title={suspiciousTitle(s.deliveryProfit)}>
                    {fmtCurrency(r.delivery_profit)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryMargin, absoluteThreeColor(marginAchievement(r.delivery_margin, 0.12)))}`} title={suspiciousTitle(s.deliveryMargin)}>
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
