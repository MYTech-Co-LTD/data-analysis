"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";
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
} from "@/lib/report-center/guard";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { TotalAnomalyBadge } from "./data-guard-badges";
import { CategoryItemDrawer } from "./category-item-drawer";
import { MaskedBadge } from "./masked-badge";
import { ModuleError, formatModuleError } from "./module-error";
import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";
import { useCanSeeCost } from "./use-can-see-cost";

interface CategorySummaryProps {
  result: GetterResult<CategorySummaryRow>;
  targetMonth: number;
  targetId: number;
  isMobile?: boolean;
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

export function CategorySummary({ result, targetMonth, targetId, isMobile = false }: CategorySummaryProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);
  const [drawerCat, setDrawerCat] = useState<string | null>(null);
  // F2.3: costMasked=true 时所有 profit/margin 列头挂角标。
  // 注意：profit_*_target 是目标值不脱敏（不挂角标）；只 profit_actual/rate/margin + daily_* 挂。
  const costMasked = !useCanSeeCost();

  // 排除「合计」行（视图可能返回），tbody 只展示明细，tfoot 展示合计
  const detailRows = useMemo(
    () => rows.filter((r) => r.category !== "合计"),
    [rows],
  );

  // 合计行：SUM 各列数值，率 = 合计实际/合计目标（前端算）
  // 成本脱敏时视图对 profit_actual/daily_profit 返回 NULL（类型标注为 number 是已知 type gap）
  // 参考 supply-chain-outbound-table.tsx：用 hasProfit/hasDailyProfit 标志，全脱敏时保持 null -> 显示「-」而非「¥0」
  const totals = useMemo(() => {
    let saleTarget = 0;
    let saleActual = 0;
    let profitTarget = 0;
    let profitSum = 0;
    let hasProfit = false;
    let dailyAmount = 0;
    let dailyProfitSum = 0;
    let hasDailyProfit = false;
    let remainingDailyProfitTarget = 0;
    for (const r of detailRows) {
      saleTarget += r.sale_target;
      saleActual += r.sale_actual;
      profitTarget += r.profit_target;
      dailyAmount += r.daily_amount;
      remainingDailyProfitTarget += r.remaining_daily_profit_target;
      // sale/delivery 不脱敏，直接累加；profit 脱敏时为 NULL，不可 +=（null+0=0 会误显「¥0」）
      if (r.profit_actual != null) {
        profitSum += r.profit_actual;
        hasProfit = true;
      }
      if (r.daily_profit != null) {
        dailyProfitSum += r.daily_profit;
        hasDailyProfit = true;
      }
    }
    const profitActual = hasProfit ? profitSum : null;
    const dailyProfit = hasDailyProfit ? dailyProfitSum : null;
    return {
      saleTarget,
      saleActual,
      profitTarget,
      profitActual,
      dailyAmount,
      dailyProfit,
      remainingDailyProfitTarget,
      saleRate: saleTarget > 0 ? saleActual / saleTarget : null,
      profitRate: profitActual != null && profitTarget > 0 ? profitActual / profitTarget : null,
      profitMargin: profitActual != null && saleActual > 0 ? profitActual / saleActual : null,
      dailyProfitMargin: dailyProfit != null && dailyAmount > 0 ? dailyProfit / dailyAmount : null,
    };
  }, [detailRows]);

  // F3 合计自洽：前端重算 totals vs 视图 category='合计' 行，不一致 → 角标「合计异常」（不阻断渲染）
  const totalAnomaly = useMemo(() => {
    const vr = rows.find((r) => r.category === "合计");
    if (!vr || detailRows.length === 0) return false;
    return !(
      numMatch(totals.saleTarget, vr.sale_target, 1, amountsClose) &&
      numMatch(totals.saleActual, vr.sale_actual, 1, amountsClose) &&
      numMatch(totals.profitTarget, vr.profit_target, 1, amountsClose) &&
      numMatch(totals.profitActual, vr.profit_actual, 1, amountsClose) &&
      numMatch(totals.dailyAmount, vr.daily_amount, 1, amountsClose) &&
      numMatch(totals.dailyProfit, vr.daily_profit, 1, amountsClose) &&
      numMatch(
        totals.remainingDailyProfitTarget,
        vr.remaining_daily_profit_target,
        1,
        amountsClose,
      ) &&
      numMatch(totals.saleRate, vr.sale_rate, 1e-3, ratesClose) &&
      numMatch(totals.profitRate, vr.profit_rate, 1e-3, ratesClose) &&
      numMatch(totals.profitMargin, vr.profit_margin, 1e-3, ratesClose) &&
      numMatch(totals.dailyProfitMargin, vr.daily_profit_margin, 1e-3, ratesClose)
    );
  }, [rows, detailRows, totals]);

  // 移动端：点行末 ▸ 看该品类全字段（12 列）
  const [detailCat, setDetailCat] = useState<CategorySummaryRow | null>(null);
  function buildCategoryFields(d: CategorySummaryRow): DetailField[] {
    return [
      { label: "月销售目标", value: fmtCurrency(d.sale_target) },
      { label: "月销售金额", value: fmtCurrency(d.sale_actual) },
      { label: "月销售完成率", value: fmtRate(d.sale_rate) },
      { label: "月毛利目标", value: fmtCurrency(d.profit_target) },
      { label: "月毛利金额", value: fmtCurrency(d.profit_actual) },
      { label: "月毛利完成率", value: fmtRate(d.profit_rate) },
      { label: "月毛利率", value: fmtRate(d.profit_margin), color: marginColor(d.profit_margin) },
      { label: "当天出库金额", value: fmtCurrency(d.daily_amount) },
      { label: "当天出库毛利", value: fmtCurrency(d.daily_profit) },
      { label: "当天毛利率", value: fmtRate(d.daily_profit_margin), color: marginColor(d.daily_profit_margin) },
      { label: "差额日均毛利目标", value: fmtCurrency(d.remaining_daily_profit_target) },
    ];
  }

  const handleExcel = () => {
    const head = [
      "类别", "月销售目标", "月销售金额", "月销售完成率",
      "月毛利目标", "月毛利金额", "月毛利完成率", "月毛利率",
      "当天出库金额", "当天出库毛利", "当天毛利率", "差额日均毛利目标",
    ];
    const body = detailRows.map((r) => [
      r.category,
      r.sale_target, r.sale_actual, fmtRate(r.sale_rate),
      r.profit_target, r.profit_actual ?? "", fmtRate(r.profit_rate), fmtRate(r.profit_margin),
      r.daily_amount, r.daily_profit ?? "", fmtRate(r.daily_profit_margin),
      r.remaining_daily_profit_target,
    ]);
    body.push([
      "合计",
      totals.saleTarget, totals.saleActual, fmtRate(totals.saleRate),
      totals.profitTarget, totals.profitActual ?? "", fmtRate(totals.profitRate), fmtRate(totals.profitMargin),
      totals.dailyAmount, totals.dailyProfit ?? "", fmtRate(totals.dailyProfitMargin),
      totals.remainingDailyProfitTarget,
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

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={formatModuleError("类别出库报表加载失败", error)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {targetMonth}月仓储出库数据报表
        </h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} isMobile={isMobile} />
      </div>
      {/* 桌面：12 列宽表（原样不动） */}
      {!isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-3 py-2 text-left font-medium">类别</th>
                <th className="px-3 py-2 text-right font-medium">月销售目标</th>
                <th className="px-3 py-2 text-right font-medium">月销售金额</th>
                <th className="px-3 py-2 text-right font-medium">月销售完成率</th>
                <th className="px-3 py-2 text-right font-medium">月毛利目标</th>
                <th className="px-3 py-2 text-right font-medium">
                  月毛利金额{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  月毛利完成率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  月毛利率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">当天出库金额</th>
                <th className="px-3 py-2 text-right font-medium">
                  当天出库毛利{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  当天毛利率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">差额日均毛利目标</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detailRows.length === 0 && (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              )}
              {detailRows.map((r) => {
                // F4: 该行各字段是否「可疑」（负值/越界比率/非数值），可疑 → 标红 + tooltip
                const s = {
                  saleTarget: isSuspiciousAmount(r.sale_target),
                  saleActual: isSuspiciousAmount(r.sale_actual),
                  saleRate: isSuspiciousRate(r.sale_rate),
                  profitTarget: isSuspiciousAmount(r.profit_target),
                  profitActual: isSuspiciousProfit(r.profit_actual),
                  profitRate: isSuspiciousRate(r.profit_rate),
                  profitMargin: isSuspiciousMargin(r.profit_margin),
                  dailyAmount: isSuspiciousAmount(r.daily_amount),
                  dailyProfit: isSuspiciousProfit(r.daily_profit),
                  dailyProfitMargin: isSuspiciousMargin(r.daily_profit_margin),
                  remaining: isSuspiciousAmount(r.remaining_daily_profit_target),
                };
                return (
                <tr
                  key={r.category}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => setDrawerCat(r.category)}
                >
                  <td className="px-3 py-2 text-slate-700 font-medium">
                    <span className="inline-flex items-center gap-1">
                      <ChevronRight size={14} strokeWidth={1.5} className="text-slate-400" />
                      {r.category}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleTarget, "text-slate-700")}`} title={suspiciousTitle(s.saleTarget)}>
                    {fmtCurrency(r.sale_target)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleActual, "text-slate-700")}`} title={suspiciousTitle(s.saleActual)}>
                    {fmtCurrency(r.sale_actual)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleRate, "text-slate-700")}`} title={suspiciousTitle(s.saleRate)}>
                    {fmtRate(r.sale_rate)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.profitTarget, "text-slate-700")}`} title={suspiciousTitle(s.profitTarget)}>
                    {fmtCurrency(r.profit_target)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.profitActual, "text-slate-700")}`} title={suspiciousTitle(s.profitActual)}>
                    {fmtCurrency(r.profit_actual)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.profitRate, "text-slate-700")}`} title={suspiciousTitle(s.profitRate)}>
                    {fmtRate(r.profit_rate)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.profitMargin, marginColor(r.profit_margin))}`} title={suspiciousTitle(s.profitMargin)}>
                    {fmtRate(r.profit_margin)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.dailyAmount, "text-slate-700")}`} title={suspiciousTitle(s.dailyAmount)}>
                    {fmtCurrency(r.daily_amount)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.dailyProfit, "text-slate-700")}`} title={suspiciousTitle(s.dailyProfit)}>
                    {fmtCurrency(r.daily_profit)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.dailyProfitMargin, marginColor(r.daily_profit_margin))}`} title={suspiciousTitle(s.dailyProfitMargin)}>
                    {fmtRate(r.daily_profit_margin)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.remaining, "text-slate-700")}`} title={suspiciousTitle(s.remaining)}>
                    {fmtCurrency(r.remaining_daily_profit_target)}
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
                <td className="px-3 py-2 text-left">
                  合计{totalAnomaly && <TotalAnomalyBadge />}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.saleTarget), "")}`}>
                  {fmtCurrency(totals.saleTarget)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.saleActual), "")}`}>
                  {fmtCurrency(totals.saleActual)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousRate(totals.saleRate), "")}`}>
                  {fmtRate(totals.saleRate)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.profitTarget), "")}`}>
                  {fmtCurrency(totals.profitTarget)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousProfit(totals.profitActual), "")}`}>
                  {fmtCurrency(totals.profitActual)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousRate(totals.profitRate), "")}`}>
                  {fmtRate(totals.profitRate)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousMargin(totals.profitMargin), marginColor(totals.profitMargin))}`}>
                  {fmtRate(totals.profitMargin)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.dailyAmount), "")}`}>
                  {fmtCurrency(totals.dailyAmount)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousProfit(totals.dailyProfit), "")}`}>
                  {fmtCurrency(totals.dailyProfit)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousMargin(totals.dailyProfitMargin), marginColor(totals.dailyProfitMargin))}`}>
                  {fmtRate(totals.dailyProfitMargin)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.remainingDailyProfitTarget), "")}`}>
                  {fmtCurrency(totals.remainingDailyProfitTarget)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 移动：精简 4 列（类别 · 销售率 · 毛利率 · 当天出库）+ 行末 ▸ 看全字段。
          行 tap 类别名 → 商品明细抽屉（保留）；▸ 行末按钮 → 全字段抽屉（新）。两个独立 tap 区。 */}
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">类别</th>
                <th className="px-2 py-2 text-right font-medium">销售率</th>
                <th className="px-2 py-2 text-right font-medium">
                  毛利率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-2 py-2 text-right font-medium">当天出库</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detailRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              )}
              {detailRows.map((r) => {
                const s = {
                  saleRate: isSuspiciousRate(r.sale_rate),
                  profitMargin: isSuspiciousMargin(r.profit_margin),
                  dailyAmount: isSuspiciousAmount(r.daily_amount),
                };
                return (
                <tr key={r.category}>
                  <td className="px-2 py-2 text-slate-700 font-medium">
                    <button
                      onClick={() => setDrawerCat(r.category)}
                      className="flex min-h-8 items-center gap-1 text-left"
                    >
                      <ChevronRight size={14} strokeWidth={1.5} className="text-slate-400" />
                      <span>{r.category}</span>
                    </button>
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(s.saleRate, "text-slate-700")}`} title={suspiciousTitle(s.saleRate)}>
                    {fmtRate(r.sale_rate)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(s.profitMargin, marginColor(r.profit_margin))}`} title={suspiciousTitle(s.profitMargin)}>
                    {fmtRate(r.profit_margin)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(s.dailyAmount, "text-slate-700")}`} title={suspiciousTitle(s.dailyAmount)}>
                    {fmtCurrency(r.daily_amount)}
                  </td>
                  <td className="px-1 py-2 text-right">
                    <button
                      onClick={() => setDetailCat(r)}
                      aria-label="查看全部字段"
                      className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700"
                    >
                      <ChevronRight size={16} strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
                <td className="px-2 py-2 text-left">
                  合计{totalAnomaly && <TotalAnomalyBadge />}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousRate(totals.saleRate), "")}`}>
                  {fmtRate(totals.saleRate)}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousMargin(totals.profitMargin), marginColor(totals.profitMargin))}`}>
                  {fmtRate(totals.profitMargin)}
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(isSuspiciousAmount(totals.dailyAmount), "")}`}>
                  {fmtCurrency(totals.dailyAmount)}
                </td>
                <td className="px-1 py-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {drawerCat && (
        <CategoryItemDrawer
          targetId={targetId}
          category={drawerCat}
          onClose={() => setDrawerCat(null)}
        />
      )}

      <RowDetailDrawer
        open={!!detailCat}
        title={detailCat?.category ?? ""}
        fields={detailCat ? buildCategoryFields(detailCat) : []}
        onClose={() => setDetailCat(null)}
      />
    </div>
  );
}
