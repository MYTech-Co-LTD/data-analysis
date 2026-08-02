// web/app/reports/targets/[id]/loading.tsx
// 看板取数期间骨架，按 cookie device_type 复刻实际布局（PC: Header+Sidebar+main；移动: Header+卡片流），避免窄条/布局跳变
import { cookies } from "next/headers";

export default async function Loading() {
  const device = (await cookies()).get("device_type")?.value;
  if (device === "mobile") {
    return (
      <div className="mx-auto max-w-md min-h-screen bg-gray-50 p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
          <div className="h-7 w-7 animate-pulse rounded-full bg-slate-200" />
        </div>
        {/* 目标名 + 数据更新 */}
        <div className="space-y-1">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
          <div className="h-3 w-56 animate-pulse rounded bg-slate-200" />
        </div>
        {/* 指标 tab */}
        <div className="flex gap-2 overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-7 w-16 shrink-0 animate-pulse rounded-full bg-slate-200"
            />
          ))}
        </div>
        <div className="h-44 animate-pulse rounded-lg border border-slate-200 bg-white" />
        {/* 趋势 */}
        <div className="h-44 animate-pulse rounded-lg border border-slate-200 bg-white" />
        {/* 排行 */}
        <div className="h-44 animate-pulse rounded-lg border border-slate-200 bg-white" />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="h-12 border-b bg-white" />
      <div className="flex">
        {/* Sidebar */}
        <div className="w-[200px] min-h-[calc(100vh-48px)] border-r bg-white p-4 space-y-2">
          <div className="h-5 w-24 animate-pulse rounded bg-slate-200" />
          <div className="h-5 w-20 animate-pulse rounded bg-slate-200" />
          <div className="h-5 w-16 animate-pulse rounded bg-slate-200" />
        </div>
        {/* main: DesktopDashboard 布局 */}
        <div className="flex-1 mx-auto max-w-[1100px] p-6 space-y-5">
          {/* 目标头 */}
          <div className="space-y-1">
            <div className="h-6 w-56 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-72 animate-pulse rounded bg-slate-200" />
          </div>
          {/* KPI 4 卡 */}
          <div className="grid grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-md border border-slate-200 bg-white"
              />
            ))}
          </div>
          {/* 趋势 + 排行 2:1 */}
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 h-72 animate-pulse rounded-lg border border-slate-200 bg-white" />
            <div className="h-72 animate-pulse rounded-lg border border-slate-200 bg-white" />
          </div>
          {/* 交叉表 */}
          <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-white" />
        </div>
      </div>
    </div>
  );
}
