import { notFound } from "next/navigation";

import { getDeviceType } from "@/lib/get-device-type";
import { getClient } from "@/lib/api";
import { getTargetKpi, type TargetKpiRow } from "@/lib/report-center/targets";
import { getRegionBreakdown, type RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { getCategorySummary, type CategorySummaryRow } from "@/lib/report-center/category-summary";
import { getBrandMetric, type BrandMetricRow } from "@/lib/report-center/brand-metric";
import {
  getItemBreakdownTop,
  type ItemBreakdownResult,
  type TopBoard,
} from "@/lib/report-center/item-breakdown";
import { getSupplyChainOutbound, type SupplyChainOutboundRow } from "@/lib/report-center/supply-chain-outbound";
import { getWholesaleDaily, type WholesaleDailyRow } from "@/lib/report-center/wholesale-daily";
import { type GetterResult } from "@/lib/report-center/types";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { PartialDegradeBanner } from "@/components/report-center/partial-degrade-banner";
import { PermissionBanner } from "@/components/report-center/permission-banner";
import { DesktopDashboard } from "./desktop";
import { MobileDashboard } from "./mobile";

export const dynamic = "force-dynamic";

// 空的 GetterResult（用于 allSettled rejected 兜底——getter 内部已 catch，
// 理论上不会 reject；这里防御性，确保不抛 unhandled promise rejection）。
function errResult<T>(): GetterResult<T> {
  return { rows: [], status: "error" };
}

// 看板页：取数 + 按设备分发。PC Header+Sidebar，移动 Header only（参照 reports/[id]/layout.tsx）。
export default async function TargetDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const targetId = Number(id);
  const isMobile = (await getDeviceType()) === "mobile";

  const client = await getClient();

  // M8（Task 3 review）：report_achievement_gen 的 total 行查询原先用
  // `if (!totalRows?.length) notFound()`——PostgREST error 时 totalRows===undefined → 误判 notFound。
  // 改为：try/catch + 显式 error 标记。
  //   - 查询成功 && rows===0 → notFound（目标真不存在）
  //   - 查询失败（error 抛出或 res.error）→ 不 notFound，标记 totalFailed=true，
  //     走降级渲染（只显示横幅，不渲染依赖 t 的 dashboard）
  //   - 查询成功 && rows>0 → 正常渲染
  let totalRows: Record<string, unknown>[] | null = null;
  let totalFailed = false;
  try {
    const res = await client.database
      .from("report_achievement_gen")
      .select("*")
      .eq("target_id", targetId)
      .eq("target_level", "total")
      .limit(1);
    if (res.error) {
      throw res.error;
    }
    totalRows = (res.data ?? null) as Record<string, unknown>[] | null;
  } catch (e) {
    console.error("report_achievement_gen total fetch failed:", e);
    totalFailed = true;
  }

  // 只有"查询成功且 total 行数为 0"才 notFound（目标真不存在）
  if (!totalFailed && !totalRows?.length) notFound();

  // 取数失败：不 notFound，渲染降级页（横幅 + Header/Sidebar 外壳保持一致）
  // M9：total 查询失败≠模块 getter 失败（7 个 getter 根本没跑），不再显示 "7/7 个模块加载失败"
  //（错误计数无意义），改 variant="total-failed" 显示「看板数据加载失败」，保留重试。
  if (totalFailed || !totalRows?.length) {
    const fallback = (
      <div className={isMobile ? "p-4" : "p-6"}>
        <PartialDegradeBanner variant="total-failed" />
        <PermissionBanner />
      </div>
    );
    return isMobile ? (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1 px-3">{fallback}</main>
      </div>
    ) : (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <div className="flex">
          <Sidebar />
          <main className="flex-1">{fallback}</main>
        </div>
      </div>
    );
  }

  const t = totalRows[0] as {
    status: string;
    start_date: string;
    end_date: string;
    days_elapsed: number | null;
    total_days: number | null;
    name: string;
    [key: string]: unknown;
  };
  // 已定格目标：各模块从 target_snapshot_breakdowns 读 close_target 冻结快照（视图不再算 closed 目标）
  const closed = t.status === "closed";

  // F1.2: Promise.allSettled + GetterResult——单 getter 失败不挂整页。
  // 7 个 getter 内部已 catch（返 status:'error'），allSettled 是双保险。
  const results = await Promise.allSettled([
    getTargetKpi(targetId),
    getRegionBreakdown(id, closed),
    getCategorySummary(id, closed),
    getBrandMetric(targetId, closed),
    getItemBreakdownTop(targetId, closed),
    getSupplyChainOutbound(targetId, closed),
    getWholesaleDaily(targetId, closed),
  ]);

  const kpi =
    results[0].status === "fulfilled"
      ? results[0].value
      : errResult<TargetKpiRow>();
  const regionBreakdown =
    results[1].status === "fulfilled"
      ? results[1].value
      : errResult<RegionBreakdownRow>();
  const categorySummary =
    results[2].status === "fulfilled"
      ? results[2].value
      : errResult<CategorySummaryRow>();
  const brandMetric =
    results[3].status === "fulfilled"
      ? results[3].value
      : errResult<BrandMetricRow>();
  const itemTop: ItemBreakdownResult =
    results[4].status === "fulfilled"
      ? results[4].value
      : (() => {
          // M10：TopBoard.totalProfit 契约是 number|null（脱敏全 null 时透传 null），
          // rejected 兜底空 board 用 null 而非 0，与脱敏语义一致（0 会误导显示 ¥0）。
          const emptyBoard: TopBoard = {
            rows: [],
            totalAmount: 0,
            totalProfit: null,
          };
          return {
            saleMonth: { ...emptyBoard },
            saleDay: { ...emptyBoard },
            outboundMonth: { ...emptyBoard },
            outboundDay: { ...emptyBoard },
            defaultDay: "",
            status: "error",
          };
        })();
  const supplyChain =
    results[5].status === "fulfilled"
      ? results[5].value
      : errResult<SupplyChainOutboundRow>();
  const wholesaleDaily =
    results[6].status === "fulfilled"
      ? results[6].value
      : errResult<WholesaleDailyRow>();

  // 统计失败模块数（getter 内部 catch 走 status:'error'；或 allSettled rejected）
  const failCount = [
    kpi,
    regionBreakdown,
    categorySummary,
    brandMetric,
    itemTop,
    supplyChain,
    wholesaleDaily,
  ].filter((r) => r?.status === "error").length;

  // 数据新鲜度：3 表最早 /compute 时间（updated_at min）
  let freshness: string | null = null;
  try {
    const fr = await client.database.rpc("get_data_freshness");
    freshness = fr.data as unknown as string | null;
  } catch {}

  // 计算时间进度
  const progress =
    t.days_elapsed && t.total_days ? t.days_elapsed / t.total_days : 0;

  // 提取月份
  const targetMonth = new Date(t.start_date).getMonth() + 1;

  const banner = (
    <>
      {failCount > 0 && <PartialDegradeBanner failCount={failCount} total={7} />}
      {/* F2.2：限门店用户（如店长）RLS 裁剪提示——内部 fetch /api/me 自判显隐 */}
      <PermissionBanner />
    </>
  );

  // F1.3：透传 GetterResult（不再解包 .rows），组件级 status='error' 显示模块失败占位。
  // itemTop 整对象传（ItemBreakdownResult 含 4 board + status/error）。
  const dashboard = isMobile ? (
    <>
      {banner}
      <MobileDashboard
        target={t}
        kpi={kpi}
        regionBreakdown={regionBreakdown}
        categorySummary={categorySummary}
        brandMetric={brandMetric}
        progress={progress}
        targetMonth={targetMonth}
        freshness={freshness}
        targetId={targetId}
        itemTop={itemTop}
        supplyChain={supplyChain}
        wholesaleDaily={wholesaleDaily}
      />
    </>
  ) : (
    <div className="p-6">
      {banner}
      <DesktopDashboard
        target={t}
        kpi={kpi}
        regionBreakdown={regionBreakdown}
        categorySummary={categorySummary}
        brandMetric={brandMetric}
        progress={progress}
        targetMonth={targetMonth}
        freshness={freshness}
        targetId={targetId}
        itemTop={itemTop}
        supplyChain={supplyChain}
        wholesaleDaily={wholesaleDaily}
      />
    </div>
  );

  // 外壳：PC Header + Sidebar，移动 Header only（不要丢 Header）
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1 px-3">{dashboard}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1">{dashboard}</main>
      </div>
    </div>
  );
}
