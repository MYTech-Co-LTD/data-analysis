"use client";

import { useRouter } from "next/navigation";

// F1.3 模块级降级占位：单个报表组件 getter 返 status==='error' 时渲染。
//
// 与 page.tsx 顶部 PartialDegradeBanner（全局 N/7 失败计数横幅）并存：
//   - PartialDegradeBanner：全局概览（顶部一行）
//   - ModuleError：组件级精确占位（替换该模块的空白区域，避免"暂无数据"误导）
//
// 设计：client component（useRouter().refresh 触发 RSC re-render 重新取数）。
// 调用方（已是 client）可传 onRetry 覆盖默认 refresh 行为；默认走 router.refresh()。
// 错误消息从 AppError.message 取（已 wrapError 友好化）；未提供时显示通用兜底文案。

// M14：统一模块加载失败文案模板——`${prefix}${error?.message ? `（${error.message}）` : ""}`。
// 7 个报表组件（brand-metric/region/category/supply-chain/wholesale-daily/kpi-cards/item-top-boards）
// 复用此 helper，避免同一模板各写一份（错误消息已 wrapError 友好化，仅透传 message 即可）。
export function formatModuleError(
  prefix: string,
  error?: { message?: string } | null,
): string {
  return `${prefix}${error?.message ? `（${error.message}）` : ""}`;
}

export function ModuleError({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const router = useRouter();
  const handleRetry = onRetry ?? (() => router.refresh());
  return (
    <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <span>
        {message ?? "本模块加载失败"}
      </span>
      <button
        type="button"
        onClick={handleRetry}
        className="rounded px-2 py-0.5 text-xs font-medium text-red-700 underline underline-offset-2 hover:bg-red-100"
      >
        重试
      </button>
    </div>
  );
}
