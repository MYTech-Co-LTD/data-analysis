"use client";

// 外部批发客户出库日报（按 biz_date 升序）。
// 数据：WholesaleDailyRow[]（wholesale_ext = 3120 熊喵除品品甜外的外部批发客户）。
// 4 列：时间 / 出库金额 / 出库毛利 / 毛利率 + 末行合计。
// 标红：wholesale_ext_margin < 0（负毛利亏损）整行标红。
// 脱敏：profit/margin 为 NULL 显示「-」；margin 是 0-1 小数（×100 显示百分比）。
// 日期下钻：点日期行 -> 展开/折叠该天客户明细子表（API route 懒加载 + 按日缓存）。
//   客户明细列：客户名称 / 出库金额 / 出库毛利 / 毛利率（margin<0 标红）。
// DESIGN.md：tabular-nums + 类 Excel 交叉表 + chart-actions 三动作。
import { Fragment, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  WholesaleDailyRow,
  WholesaleDailyCustomerRow,
} from "@/lib/report-center/wholesale-daily";
import type { GetterResult } from "@/lib/report-center/types";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { ModuleError } from "./module-error";

interface WholesaleDailyTableProps {
  result: GetterResult<WholesaleDailyRow>;
  startDate: string;
  endDate: string;
  targetId: number;
  isMobile?: boolean;
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
  result,
  startDate,
  endDate,
  targetId,
  isMobile = false,
}: WholesaleDailyTableProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);

  // 日期下钻状态
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [customers, setCustomers] = useState<
    Record<string, WholesaleDailyCustomerRow[]>
  >({});
  const [loadingDay, setLoadingDay] = useState<string | null>(null);

  const onToggleDay = async (biz_date: string) => {
    if (expandedDay === biz_date) {
      setExpandedDay(null);
      return;
    }
    setExpandedDay(biz_date);
    if (!customers[biz_date]) {
      setLoadingDay(biz_date);
      try {
        const res = await fetch("/api/admin/reports/wholesale-day-customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_id: targetId, date: biz_date }),
        }).then((r) => r.json());
        setCustomers((prev) => ({
          ...prev,
          [biz_date]: res?.rows ?? [],
        }));
      } catch {
        setCustomers((prev) => ({ ...prev, [biz_date]: [] }));
      } finally {
        setLoadingDay(null);
      }
    }
  };

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

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={`外部批发日报加载失败${error?.message ? `（${error.message}）` : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} isMobile={isMobile} />
      </div>
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-500">
            <tr className="sticky top-0 z-10 bg-slate-50">
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
              const isOpen = expandedDay === r.biz_date;
              const isLoading = loadingDay === r.biz_date;
              const dayCustomers = customers[r.biz_date] ?? [];
              return (
                <Fragment key={r.biz_date}>
                  <tr
                    className={`${rowBg} cursor-pointer`}
                    onClick={() => onToggleDay(r.biz_date)}
                  >
                    <td className="px-3 py-2 text-left text-slate-700">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-flex items-center text-slate-400">
                          {isOpen ? (
                            <ChevronDown size={14} strokeWidth={1.5} />
                          ) : (
                            <ChevronRight size={14} strokeWidth={1.5} />
                          )}
                        </span>
                        {r.biz_date}
                      </span>
                    </td>
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
                  {isOpen && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={4} className="px-3 py-2">
                        {isLoading ? (
                          <div className="py-3 text-center text-[11px] text-slate-400">
                            加载中…
                          </div>
                        ) : dayCustomers.length === 0 ? (
                          <div className="py-3 text-center text-[11px] text-slate-400">
                            暂无客户明细
                          </div>
                        ) : (
                          <table className="ml-4 w-full text-xs tabular-nums">
                            <thead className="text-[11px] text-slate-500">
                              <tr className="border-b border-slate-200">
                                <th className="px-2 py-1.5 text-left font-medium">
                                  客户名称
                                </th>
                                <th className="px-2 py-1.5 text-right font-medium">
                                  出库金额
                                </th>
                                <th className="px-2 py-1.5 text-right font-medium">
                                  出库毛利
                                </th>
                                <th className="px-2 py-1.5 text-right font-medium">
                                  毛利率
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {dayCustomers.map((c) => {
                                const cLow =
                                  c.wholesale_ext_customer_margin != null &&
                                  c.wholesale_ext_customer_margin < 0;
                                const cColor = cLow
                                  ? "text-red-600"
                                  : "text-slate-700";
                                const cBg = cLow ? "bg-red-50/50" : "";
                                return (
                                  <tr key={c.client_code} className={cBg}>
                                    <td
                                      className="px-2 py-1.5 text-left text-slate-700 max-w-[12rem] truncate"
                                      title={c.client_name}
                                    >
                                      {c.client_name || c.client_code || "-"}
                                    </td>
                                    <td
                                      className={`px-2 py-1.5 text-right tabular-nums ${cColor}`}
                                    >
                                      {fmtCurrency(
                                        c.wholesale_ext_customer_amount,
                                      )}
                                    </td>
                                    <td
                                      className={`px-2 py-1.5 text-right tabular-nums ${cColor}`}
                                    >
                                      {fmtProfit(
                                        c.wholesale_ext_customer_profit,
                                      )}
                                    </td>
                                    <td
                                      className={`px-2 py-1.5 text-right tabular-nums ${cColor}`}
                                    >
                                      {fmtMargin(
                                        c.wholesale_ext_customer_margin,
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
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
