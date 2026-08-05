'use client';

import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

// F1.2/1.4 部分降级横幅：page.tsx 统计 7 个 getter 中 status==='error' 的数量，
// failCount>0 时在报表看板顶部渲染。重试按钮触发 RSC re-render（重新跑取数）。
//
// M9：新增 variant="total-failed"——total 查询失败（模块 getter 根本没跑）时，
// 不显示 "N/7 个模块加载失败"（该计数对 total 失败无意义），改显示更准确的
// 「看板数据加载失败」（保留重试）。
//
// 设计：client component（useRouter）；由 page.tsx（RSC）传 failCount/total 两个 prop。
// 仅 failCount>0 时由 page 端条件渲染——本组件不做隐藏逻辑，保持单一职责。
// DESIGN.md 禁 emoji——用 lucide AlertTriangle 替代警告 emoji。
export function PartialDegradeBanner({
  failCount,
  total,
  variant = "modules",
}: {
  failCount?: number;
  total?: number;
  variant?: "modules" | "total-failed";
}) {
  const router = useRouter();
  const label =
    variant === "total-failed"
      ? "看板数据加载失败，请重试"
      : `${failCount ?? 0}/${total ?? 0} 个模块加载失败，部分数据不可用`;
  return (
    <div className="mb-3 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
      <span className="inline-flex items-center gap-1.5">
        <AlertTriangle size={16} strokeWidth={1.5} className="shrink-0" />
        {label}
      </span>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="rounded px-2 py-0.5 text-xs font-medium text-amber-800 underline underline-offset-2 hover:bg-amber-100"
      >
        {variant === "total-failed" ? "重试" : "重试全部"}
      </button>
    </div>
  );
}
