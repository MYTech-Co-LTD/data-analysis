import Link from "next/link";
import { Target } from "lucide-react";

import { TargetSummary } from "@/lib/report-center/targets";

// 目标列表卡：纯渲染 + next/link，Server Component（不加 "use client"）。
// 进度率(progress_rate) 作主数字并按三色编码（绿>=1 / 琥珀>=0.8 / 红<0.8）；
// 达成率(achievement_rate) 作副数字。所有数字 tabular-nums 对齐。
// 着色口径：进行中卡「进度」主数字保持绝对（它就是进度本身）；「达成」副文本按
// 「达成率 / 时间进度」相对着色（对齐 KPI 比率带）；已结束无时间进度概念，达成率保持绝对。

function fmtPct(r: number) {
  return (r * 100).toFixed(1) + "%";
}

function rateColor(r: number) {
  return r >= 1 ? "text-green-600" : r >= 0.8 ? "text-amber-600" : "text-red-600";
}

// 相对进度的达成率三色（对齐 KPI 比率带）：achievement/progress >=1 绿 / >=0.8 琥珀 / <0.8 红。
function rateColorByProgress(achievement: number, progress: number) {
  return rateColor(achievement / (progress || 0.0001));
}

export function TargetList({ targets }: { targets: TargetSummary[] }) {
  if (!targets.length) {
    return (
      <div className="text-center text-slate-400 py-12 text-sm">暂无目标</div>
    );
  }
  return (
    <div className="grid gap-3">
      {targets.map((t) => (
        <Link
          key={t.target_id}
          href={`/reports/targets/${t.target_id}`}
          prefetch={false}
          className="group flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-4 transition hover:border-blue-400 hover:shadow-sm"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Target
                size={18}
                strokeWidth={1.5}
                className="shrink-0 text-blue-600"
              />
              <span className="truncate font-medium text-slate-800">
                {t.name}
              </span>
              <span
                className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${
                  t.status === "active"
                    ? "bg-blue-50 text-blue-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {t.status === "active" ? "进行中" : "已结束"}
              </span>
              <span className="whitespace-nowrap text-xs text-slate-400">
                {t.target_type === "store" ? "门店" : "总部"}
              </span>
            </div>
            <div className="mt-1 pl-7 text-xs tabular-nums text-slate-400">
              {t.start_date} ~ {t.end_date}
            </div>
          </div>
          <div className="ml-4 shrink-0 text-right tabular-nums">
            {t.status === "active" ? (
              <>
                <div className="text-[11px] text-slate-400">进度</div>
                <div className={`text-xl font-semibold ${rateColor(t.sample_progress_rate)}`}>
                  {fmtPct(t.sample_progress_rate)}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  达成{" "}
                  <span
                    className={rateColorByProgress(
                      t.sample_achievement_rate,
                      t.sample_progress_rate,
                    )}
                  >
                    {fmtPct(t.sample_achievement_rate)}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="text-[11px] text-slate-400">达成</div>
                <div className={`text-xl font-semibold ${rateColor(t.sample_achievement_rate)}`}>
                  {fmtPct(t.sample_achievement_rate)}
                </div>
              </>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
