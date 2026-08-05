"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { KpiCards } from "@/components/report-center/kpi-cards";
import { RegionDrillTable } from "@/components/report-center/region-drill-table";
import { CategorySummary } from "@/components/report-center/category-summary";
import { BrandMetricTable } from "@/components/report-center/brand-metric-table";
import { SaleTopBoards, OutboundTopBoards, useItemDayBoards } from "@/components/report-center/item-top-boards";
import { SupplyChainOutboundTable } from "@/components/report-center/supply-chain-outbound-table";
import { WholesaleDailyTable } from "@/components/report-center/wholesale-daily-table";
import type { GetterResult } from "@/lib/report-center/types";
import type { TargetKpiRow } from "@/lib/report-center/targets";
import type { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import type { CategorySummaryRow } from "@/lib/report-center/category-summary";
import type { BrandMetricRow } from "@/lib/report-center/brand-metric";
import type {
  ItemBreakdownResult,
} from "@/lib/report-center/item-breakdown";
import type { SupplyChainOutboundRow } from "@/lib/report-center/supply-chain-outbound";
import type { WholesaleDailyRow } from "@/lib/report-center/wholesale-daily";

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
  brandMetric,
  progress,
  targetMonth,
  freshness,
  targetId,
  itemTop,
  supplyChain,
  wholesaleDaily,
}: {
  target: any;
  kpi: GetterResult<TargetKpiRow>;
  regionBreakdown: GetterResult<RegionBreakdownRow>;
  categorySummary: GetterResult<CategorySummaryRow>;
  brandMetric: GetterResult<BrandMetricRow>;
  progress: number;
  targetMonth: number;
  freshness: string | null;
  targetId: number;
  itemTop: ItemBreakdownResult;
  supplyChain: GetterResult<SupplyChainOutboundRow>;
  wholesaleDaily: GetterResult<WholesaleDailyRow>;
}) {
  // 日榜 day state（销售/出库共用，切日并行请求两 metric）
  const { day, saleDay, outboundDay, onDayChange, busy } = useItemDayBoards(
    targetId,
    itemTop.defaultDay,
    itemTop.saleDay,
    itemTop.outboundDay,
  );
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
        <KpiCards result={kpi} isMobile />
      </div>

      {/* 品牌×指标 */}
      <div className="px-4">
        <BrandMetricTable result={brandMetric} targetMonth={targetMonth} isMobile />
      </div>

      {/* 门店零售/配送数据报表（战区） */}
      <div className="px-4">
        <RegionDrillTable
          result={regionBreakdown}
          targetMonth={targetMonth}
          progress={progress}
          isMobile
        />
      </div>

      {/* 销售商品 TOP（月度+日，移动单列堆叠） */}
      <div className="px-4">
        <SaleTopBoards
          result={itemTop}
          dayBoard={saleDay}
          day={day}
          onDayChange={onDayChange}
          busy={busy}
          startDate={target.start_date}
          endDate={target.end_date}
          targetId={targetId}
        />
      </div>

      {/* 类别出库报表 */}
      <div className="px-4">
        <CategorySummary result={categorySummary} targetMonth={targetMonth} targetId={targetId} isMobile />
      </div>

      {/* 供应链出库层级 */}
      <div className="px-4">
        <SupplyChainOutboundTable
          result={supplyChain}
          startDate={target.start_date}
          endDate={target.end_date}
          targetId={targetId}
          isMobile
        />
      </div>

      {/* 外部批发日报 */}
      <div className="px-4">
        <WholesaleDailyTable
          result={wholesaleDaily}
          startDate={target.start_date}
          endDate={target.end_date}
          targetId={targetId}
          isMobile
        />
      </div>

      {/* 出库商品 TOP（月度+日，移动单列堆叠） */}
      <div className="px-4">
        <OutboundTopBoards
          result={itemTop}
          dayBoard={outboundDay}
          day={day}
          onDayChange={onDayChange}
          busy={busy}
          startDate={target.start_date}
          endDate={target.end_date}
          targetId={targetId}
        />
      </div>
    </div>
  );
}
