"use client";

// F3/F4 数据守护角标（纯展示，不阻断渲染）。
// F3 合计异常：amber 中性警示（比 PartialDegradeBanner 轻量，只做标记不做重试）。
// F4 可疑值：空间富余处（KPI 卡/抽屉/表头）用的红色「可疑」小徽标。
// DESIGN.md 禁 emoji——用 lucide AlertTriangle 图标。
import { AlertTriangle } from "lucide-react";

export function TotalAnomalyBadge({
  hint = "前端重算合计与视图合计行不一致，请核对数据",
}: {
  hint?: string;
}) {
  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 align-middle text-[10px] font-medium text-amber-700"
      title={hint}
    >
      <AlertTriangle size={10} strokeWidth={1.5} />
      合计异常
    </span>
  );
}

export function SuspiciousBadge() {
  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 rounded bg-red-100 px-1 py-0.5 align-middle text-[10px] font-medium text-red-700"
      title="数据可疑（负值/越界比率/非数值）"
    >
      <AlertTriangle size={10} strokeWidth={1.5} />
      可疑
    </span>
  );
}
