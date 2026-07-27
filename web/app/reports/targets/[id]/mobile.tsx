"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { KpiCards } from "@/components/report-center/kpi-cards";
import { RegionDrillTable } from "@/components/report-center/region-drill-table";
import { CategorySummary } from "@/components/report-center/category-summary";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";

function fmtFresh(s: string | null) {
  if (!s) return "—";
  try {
    return new Date(s)
      .toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\//g, "-");
  } catch {
    return s.slice(0, 16).replace("T", " ");
  }
}

export function MobileDashboard({
  target,
  kpi,
  regionBreakdown,
  categorySummary,
  progress,
  targetMonth,
  freshness,
}: {
  target: any;
  kpi: any[];
  regionBreakdown: RegionBreakdownRow[];
  categorySummary: CategorySummaryRow[];
  progress: number;
  targetMonth: number;
  freshness: string | null;
}) {
  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 sticky top-0 z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs text-slate-400"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          报表中心
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-800">
            {target.name}
          </h1>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              target.status === "active"
                ? "bg-blue-50 text-blue-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {target.status === "active" ? "进行中" : "已结束"}
          </span>
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-slate-400">
          {target.start_date} ~ {target.end_date} · 数据更新{" "}
          {fmtFresh(freshness)}
        </div>
      </div>

      {/* KPI 卡 */}
      <div className="px-4">
        <KpiCards rows={kpi} />
      </div>

      {/* 门店零售/配送数据报表 */}
      <div className="px-4">
        <RegionDrillTable
          rows={regionBreakdown}
          targetMonth={targetMonth}
          progress={progress}
        />
      </div>

      {/* 类别出库报表 */}
      <div className="px-4">
        <CategorySummary rows={categorySummary} targetMonth={targetMonth} />
      </div>
    </div>
  );
}
