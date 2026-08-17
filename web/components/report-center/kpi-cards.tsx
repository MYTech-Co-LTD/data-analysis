"use client";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";
import { hasKpiPerm } from "@/lib/feature-perm";
import { KPI_CARD_CAPABILITIES } from "@/lib/capability-board";
import { statusToZh } from "@/lib/report-center/status-i18n";
import { isSuspiciousRate, isSuspiciousMargin, suspiciousClass } from "@/lib/report-center/guard";
import { actualRatio, marginAchievement, absoluteThreeColor } from "@/lib/report-center/ratio";
import type { TargetKpiRow } from "@/lib/report-center/targets";
import type { GetterResult } from "@/lib/report-center/types";
import { SuspiciousBadge } from "./data-guard-badges";
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

// 达成率三色编码（DESIGN 语义色），按「达成率 / 时间进度」对比着色（相对进度）：
//   >=1   → success #16A34A（跑赢进度）
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
// 着色按「达成率 / 时间进度」对比（相对进度：跑赢进度绿/接近琥珀/落后红）；target-list 仍用绝对达成率口径。
// hover 显示 tooltip：总目标、总完成、完成率。
// F1.3：props 接 GetterResult<TargetKpiRow>（不再解包 .rows）。
//   - status==='error' → 渲染"指标加载失败"占位（不渲染空 KPI 卡，避免与 data_status 徽章混淆）
//   - status==='no-data'/ok 且 rows.length===0 → 空态（暂无指标数据）
//   - status==='ok' → 正常 4 卡（保留原 data_status 徽章机制）
export function KpiCards({
  result,
  isMobile = false,
  permissions,
}: {
  result: GetterResult<TargetKpiRow>;
  isMobile?: boolean;
  permissions?: readonly string[];
}) {
  const { rows, status, error } = result;

  // KPI 卡片级能力过滤（用户要求）：只渲染有权限的卡片。
  // hasKpiPerm 为 fail-open（未配置/无权限信息 → 全开，避免旧 token 误伤）：
  // 只有「明确配置了部分 KPI 能力」的角色才被裁剪到配置集。
  const allowedCodes = new Set<string>();
  for (const c of KPI_CARD_CAPABILITIES) if (hasKpiPerm(permissions, c.code)) allowedCodes.add(c.code);

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
  // 权限过滤后的可见卡数（0 = 全部被过滤 → 显示无权限占位）
  const visibleCodes =
    METRIC_ORDER.filter((c) => allowedCodes.has(c)).length +
    ['delivery_sale_ratio', 'outbound_margin'].filter((c) => allowedCodes.has(c)).length;
  if (visibleCodes === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-slate-400 py-8 text-sm">
        你没有可查看的指标卡——请联系管理员分配 KPI 卡片能力
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      {METRIC_ORDER.map((code) => {
        if (!allowedCodes.has(code)) return null; // KPI 卡能力过滤
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
            {(() => {
              // F4: 达成率可疑（负值/越界>1.5/非数值）→ 标红 + 「可疑」徽标；非数值显示「—」
              const susp = isSuspiciousRate(r.achievement_rate);
              const rateDisplay =
                r.achievement_rate == null ||
                !Number.isFinite(r.achievement_rate)
                  ? "—"
                  : `${(r.achievement_rate * 100).toFixed(1)}%`;
              return (
                <div
                  className={`mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular-nums ${suspiciousClass(
                    susp,
                    rateColor((r.achievement_rate ?? 0) / (progress || 0.0001)),
                  )}`}
                >
                  {rateDisplay}
                  {susp && <SuspiciousBadge />}
                </div>
              );
            })()}
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
      {/* 比率卡（派生值，不落库）：配销比现状卡 + 毛利率(12%)绝对三色卡。
          复用 4 张金额卡的 typedRows 分量相除（逐行聚合值相除 = ratio-of-sums）。
          无 data_status 徽章（派生值，状态看 4 张源卡）、无 tooltip（副行已展示分子分母）。 */}
      {(() => {
        const sale = typedRows.find((x) => x.metric_code === "sale");
        const delivery = typedRows.find((x) => x.metric_code === "delivery");
        const outboundAmt = typedRows.find((x) => x.metric_code === "outbound_amt");
        const outboundProfit = typedRows.find((x) => x.metric_code === "outbound_profit");
        const ratioCards = [
          { key: "delivery_sale_ratio", label: "总配销比", num: delivery?.actual_value ?? null, den: sale?.actual_value ?? null, numLabel: "配送", denLabel: "销售", colored: false },
          { key: "outbound_margin", label: "毛利率", num: outboundProfit?.actual_value ?? null, den: outboundAmt?.actual_value ?? null, numLabel: "毛利", denLabel: "出库", colored: true },
        ];
        return ratioCards
          .filter((c) => allowedCodes.has(c.key)) // 比率卡能力过滤（hasKpiPerm fail-open：未配置→全开）
          .map((c) => {
          // actualRatio 为通用 num/den，但仅处理 den=0；num=null（毛利脱敏）须前置守卫 → null
          const ratio: number | null = c.num == null || !c.den ? null : actualRatio(c.num, c.den);
          const susp = isSuspiciousMargin(ratio);
          const bigDisplay = ratio == null || !Number.isFinite(ratio) ? "—" : `${(ratio * 100).toFixed(1)}%`;
          const bigColor = c.colored
            ? suspiciousClass(susp, absoluteThreeColor(marginAchievement(ratio, 0.12)))
            : suspiciousClass(susp, "text-slate-800");
          const numStr = c.num == null ? "—" : fmtWan(c.num);
          const denStr = c.den == null ? "—" : fmtWan(c.den);
          return (
            <div key={c.key} className="rounded-md border p-4 text-left border-slate-200 bg-white">
              <span className="text-xs leading-tight text-slate-500">{c.label}</span>
              <div className={`mt-1 flex items-baseline gap-1 text-2xl font-semibold tabular-nums ${bigColor}`}>
                {bigDisplay}
                {susp && <SuspiciousBadge />}
              </div>
              <div className="mt-1 text-xs tabular-nums text-slate-400">
                {c.numLabel}{numStr} / {c.denLabel}{denStr}
                {c.colored && " · 目标 12%"}
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
}
