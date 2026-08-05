"use client";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";
import { statusToZh } from "@/lib/report-center/status-i18n";
import type { TargetKpiRow } from "@/lib/report-center/targets";
import type { GetterResult } from "@/lib/report-center/types";
import { ModuleError, formatModuleError } from "./module-error";

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
// F1.3：props 接 GetterResult<TargetKpiRow>（不再解包 .rows）。
//   - status==='error' → 渲染"指标加载失败"占位（不渲染空 KPI 卡，避免与 data_status 徽章混淆）
//   - status==='no-data'/ok 且 rows.length===0 → 空态（暂无指标数据）
//   - status==='ok' → 正常 4 卡（保留原 data_status 徽章机制）
export function KpiCards({
  result,
  isMobile = false,
}: {
  result: GetterResult<TargetKpiRow>;
  isMobile?: boolean;
}) {
  const { rows, status, error } = result;

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={formatModuleError("指标加载失败", error)}
        />
      </div>
    );
  }

  // M12：不做整对象双重断言（as unknown as KpiRow[]）——只收窄真正不兼容的
  // metric_code 字段（TargetKpiRow.metric_code: string → MetricCode 联合），
  // 其余字段（target_value/actual_value/achievement_rate/progress_rate/data_status）
  // 交由 tsc 做结构兼容检查，避免双重断言掩盖未来字段漂移。
  const typedRows: KpiRow[] = rows.map((r) => ({
    ...r,
    metric_code: r.metric_code as MetricCode,
  }));
  if (typedRows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-slate-400 py-8 text-sm">
        暂无指标数据
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {METRIC_ORDER.map((code) => {
        const r = typedRows.find((x) => x.metric_code === code);
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
                {isMobile ? statusToZh(r.data_status) : r.data_status}
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
            {/* Tooltip（移动端隐藏 hover tooltip） */}
            {!isMobile && (
              <KpiTooltip
                target={fmtCurrency(r.target_value)}
                actual={fmtCurrency(r.actual_value ?? 0)}
                rate={fmtPercent(r.achievement_rate ?? 0)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
