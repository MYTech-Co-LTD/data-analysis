"use client";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";

interface KpiRow {
  metric_code: MetricCode;
  target_value: number;
  actual_value: number | null;
  achievement_rate: number | null;
  progress_rate: number | null;
  data_status: string;
}

function fmtWan(v: number) {
  return v >= 10000 ? (v / 10000).toFixed(1) + "万" : v.toFixed(0);
}

function fmtCurrency(v: number): string {
  return `¥${fmtWan(v)}`;
}

function fmtPercent(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

// 达成率三色编码（DESIGN 语义色），按绝对 achievement_rate 着色：
//   >=1   → success #16A34A（达成）
//   >=0.8 → warning #D97706（接近）
//   <0.8  → error #DC2626（落后）
function rateColor(r: number) {
  return r >= 1
    ? "text-green-600"
    : r >= 0.8
      ? "text-amber-600"
      : "text-red-600";
}

function statusBadgeClass(s: string) {
  const m: Record<string, string> = {
    complete: "bg-green-50 text-green-700",
    partial: "bg-amber-50 text-amber-700",
    missing: "bg-red-50 text-red-700",
    not_ready: "bg-slate-100 text-slate-400",
  };
  return m[s] ?? m.not_ready;
}

// Tooltip 组件
function KpiTooltip({ target, actual, rate }: { target: string; actual: string; rate: string }) {
  return (
    <div className="absolute z-10 hidden group-hover:block bg-white border border-slate-200 rounded shadow-lg p-2 text-xs min-w-[140px]">
      <div className="space-y-1 tabular-nums">
        <div className="flex justify-between">
          <span className="text-slate-500">总目标</span>
          <span className="text-slate-700 font-medium">{target}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">总完成</span>
          <span className="text-slate-700 font-medium">{actual}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">完成率</span>
          <span className="text-slate-700 font-medium">{rate}</span>
        </div>
      </div>
    </div>
  );
}

// 4 指标 KPI 卡行：每卡显示 label / 达成率大数字 / 实际·目标·进度 / 数据状态徽章。
// 着色按绝对达成率（与 target-list.tsx 一致：≥1 绿/≥0.8 琥珀/<0.8 红），progress 仅作副信息。
// hover 显示 tooltip：总目标、总完成、完成率。
export function KpiCards({
  rows,
}: {
  rows: KpiRow[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-slate-400 py-8 text-sm">
        暂无指标数据
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {METRIC_ORDER.map((code) => {
        const r = rows.find((x) => x.metric_code === code);
        if (!r) return null;
        const meta = METRICS[code];
        const progress = r.progress_rate ?? 0;
        return (
          <div
            key={code}
            className="rounded-md border p-4 text-left transition relative group border-slate-200 bg-white hover:border-slate-300"
          >
            <div className="flex items-start justify-between gap-1">
              <span className="text-xs leading-tight text-slate-500">{meta.label}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${statusBadgeClass(
                  r.data_status,
                )}`}
              >
                {r.data_status}
              </span>
            </div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${rateColor(
                r.achievement_rate ?? 0,
              )}`}
            >
              {((r.achievement_rate ?? 0) * 100).toFixed(1)}%
            </div>
            <div className="mt-1 text-xs tabular-nums text-slate-400">
              {fmtWan(r.actual_value ?? 0)} / {fmtWan(r.target_value)} · 进度{" "}
              {(progress * 100).toFixed(0)}%
            </div>
            {/* Tooltip */}
            <KpiTooltip
              target={fmtCurrency(r.target_value)}
              actual={fmtCurrency(r.actual_value ?? 0)}
              rate={fmtPercent(r.achievement_rate ?? 0)}
            />
          </div>
        );
      })}
    </div>
  );
}
