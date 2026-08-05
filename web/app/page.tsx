import { getDeviceType } from "@/lib/get-device-type";
import { getTargetList } from "@/lib/report-center/targets";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { TargetList } from "@/components/report-center/target-list";

/**
 * 首页：报表中心 · 目标列表
 * 读 report_achievement_v total 行，渲染「进行中」「已结束」两段目标卡。
 * 点目标进 /reports/targets/[id] 看板。PC/移动共用 TargetList（响应式 grid）。
 */
export default async function HomePage() {
  // F1.2: getTargetList 改返 GetterResult；首页消费 .rows（失败时空列表，
  // 不再因 throw 触发 error.tsx 挂掉整页——目标列表静默降级为空，更友好）。
  const [deviceType, activeRes, closedRes] = await Promise.all([
    getDeviceType(),
    getTargetList("active"),
    getTargetList("closed"),
  ]);
  const isMobile = deviceType === "mobile";
  const activeTargets = activeRes.rows;
  const closedTargets = closedRes.rows;

  const content = (
    <>
      <h1 className="mb-4 text-xl font-semibold text-slate-800">
        报表中心 · 进行中目标
      </h1>
      <TargetList targets={activeTargets} />
      {closedTargets.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-medium text-slate-500">
            已结束
          </h2>
          <TargetList targets={closedTargets} />
        </>
      )}
    </>
  );

  if (isMobile) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Header />
        <main className="p-4">{content}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">{content}</main>
      </div>
    </div>
  );
}
