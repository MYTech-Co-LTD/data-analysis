import { notFound } from "next/navigation";

import { getDeviceType } from "@/lib/get-device-type";
import { getClient } from "@/lib/api";
import { getTargetKpi } from "@/lib/report-center/targets";
import { getRegionBreakdown } from "@/lib/report-center/region-breakdown";
import { getCategorySummary } from "@/lib/report-center/category-summary";
import { getBrandMetric } from "@/lib/report-center/brand-metric";
import {
  getItemBreakdownTop,
  getItemOutboundListPage,
} from "@/lib/report-center/item-breakdown";
import { getSupplyChainOutbound } from "@/lib/report-center/supply-chain-outbound";
import { getWholesaleDaily } from "@/lib/report-center/wholesale-daily";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { DesktopDashboard } from "./desktop";
import { MobileDashboard } from "./mobile";

export const dynamic = "force-dynamic";

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
  const { data: totalRows } = await client.database
    .from("report_achievement_v")
    .select("*")
    .eq("target_id", targetId)
    .eq("target_level", "total")
    .limit(1);
  if (!totalRows?.length) notFound();
  const t = totalRows[0];

  const [
    kpi,
    regionBreakdown,
    categorySummary,
    brandMetric,
    itemTop,
    itemList,
    supplyChain,
    wholesaleDaily,
  ] = await Promise.all([
    getTargetKpi(targetId),
    getRegionBreakdown(id),
    getCategorySummary(id),
    getBrandMetric(targetId),
    getItemBreakdownTop(targetId),
    getItemOutboundListPage(targetId, 1, {}),
    getSupplyChainOutbound(targetId),
    getWholesaleDaily(targetId),
  ]);

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

  const dashboard = isMobile ? (
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
      itemList={itemList}
      supplyChain={supplyChain}
      wholesaleDaily={wholesaleDaily}
    />
  ) : (
    <div className="p-6">
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
        itemList={itemList}
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
        <main className="flex-1">{dashboard}</main>
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
