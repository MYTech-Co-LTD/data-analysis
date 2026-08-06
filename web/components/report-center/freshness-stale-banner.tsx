"use client";

// F5 时效陈旧门：基于「最近查询时间」（collect_tasks.last_run_at 心跳，系统活跃）判陈旧。
// - 系统最近查询停留在 X 超阈值（>6h）→ 顶部红色横幅「系统最近查询停留在 X，已超 N 小时未运行」
// - 数据旧（源头没数据）不算陈旧——data_updated_at 仅展示（desktop/mobile 头部），不触发横幅。
// - last_query_at 为空（从未运行）→ 不告警。
// - freshness RPC 失败（failed=true）→ 「查询时间获取失败」
// DESIGN.md 禁 emoji——用 lucide AlertTriangle 图标。
import { AlertTriangle } from "lucide-react";
import { staleBannerText } from "@/lib/report-center/freshness";

export function FreshnessStaleBanner({
  lastQueryAt,
  failed = false,
}: {
  lastQueryAt: string | null | undefined;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <div className="mb-3 flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
        <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0" />
        <span>查询时间获取失败</span>
      </div>
    );
  }

  const text = staleBannerText(lastQueryAt);
  if (!text) return null;

  return (
    <div className="mb-3 flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
      <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}
