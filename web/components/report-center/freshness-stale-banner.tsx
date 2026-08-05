"use client";

// F5 时效陈旧门：数据停留在 X 超阈值 → 顶部红色横幅（与 PartialDegradeBanner/PermissionBanner 同位）。
// - freshness RPC 失败（failed=true）→ 「更新时间获取失败」
// - freshness 距今 > 6h → 「数据停留在 YYYY-MM-DD HH:MM，已超 N 小时未更新」
// - 正常/无数据 → 不渲染。
// DESIGN.md 禁 emoji——用 lucide AlertTriangle 图标。
import { AlertTriangle } from "lucide-react";
import {
  formatFreshnessChina,
  FRESHNESS_STALE_HOURS,
  staleHoursSince,
} from "@/lib/report-center/freshness";

export function FreshnessStaleBanner({
  freshness,
  failed = false,
}: {
  freshness: string | null | undefined;
  failed?: boolean;
}) {
  if (failed) {
    return (
      <div className="mb-3 flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
        <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0" />
        <span>更新时间获取失败</span>
      </div>
    );
  }

  const hours = staleHoursSince(freshness);
  if (hours == null || hours <= FRESHNESS_STALE_HOURS) return null;

  const display = formatFreshnessChina(freshness) ?? freshness ?? "";
  return (
    <div className="mb-3 flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
      <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0" />
      <span>
        数据停留在 {display}，已超 {hours} 小时未更新
      </span>
    </div>
  );
}
