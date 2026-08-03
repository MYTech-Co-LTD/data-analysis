"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { CategoryItemDrawer } from "./category-item-drawer";
import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";

interface CategorySummaryProps {
  rows: CategorySummaryRow[];
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

export function CategorySummary({ rows, targetMonth, targetId, isMobile = false }: CategorySummaryProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const [drawerCat, setDrawerCat] = useState<string | null>(null);

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
                <th className="px-3 py-2 text-right font-medium">月毛利金额</th>
                <th className="px-3 py-2 text-right font-medium">月毛利完成率</th>
                <th className="px-3 py-2 text-right font-medium">月毛利率</th>
                <th className="px-3 py-2 text-right font-medium">当天出库金额</th>
                <th className="px-3 py-2 text-right font-medium">当天出库毛利</th>
                <th className="px-3 py-2 text-right font-medium">当天毛利率</th>
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
              {detailRows.map((r) => (
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
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
                <td className="px-3 py-2 text-left">合计</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.saleTarget)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.saleActual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtRate(totals.saleRate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.profitTarget)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.profitActual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtRate(totals.profitRate)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(totals.profitMargin)}`}>
                  {fmtRate(totals.profitMargin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.dailyAmount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.dailyProfit)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(totals.dailyProfitMargin)}`}>
                  {fmtRate(totals.dailyProfitMargin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
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
                <th className="px-2 py-2 text-right font-medium">毛利率</th>
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
              {detailRows.map((r) => (
                <tr key={r.category}>
                  <td className="px-2 py-2 text-slate-700 font-medium">
                    <button
                      onClick={() => setDrawerCat(r.category)}
                      className="flex items-center gap-1 text-left"
                    >
                      <ChevronRight size={14} strokeWidth={1.5} className="text-slate-400" />
                      <span>{r.category}</span>
                    </button>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                    {fmtRate(r.sale_rate)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${marginColor(r.profit_margin)}`}>
                    {fmtRate(r.profit_margin)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">
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
              ))}
            </tbody>
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
