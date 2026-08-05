'use client';

import { useRouter } from 'next/navigation';

// F1.2/1.4 部分降级横幅：page.tsx 统计 7 个 getter 中 status==='error' 的数量，
// failCount>0 时在报表看板顶部渲染。重试按钮触发 RSC re-render（重新跑取数）。
//
// 设计：client component（useRouter）；由 page.tsx（RSC）传 failCount/total 两个 prop。
// 仅 failCount>0 时由 page 端条件渲染——本组件不做隐藏逻辑，保持单一职责。
export function PartialDegradeBanner({
  failCount,
  total,
}: {
  failCount: number;
  total: number;
}) {
  const router = useRouter();
  return (
    <div className="mb-3 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
      <span>
        ⚠️ {failCount}/{total} 个模块加载失败，部分数据不可用
      </span>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="rounded px-2 py-0.5 text-xs font-medium text-amber-800 underline underline-offset-2 hover:bg-amber-100"
      >
        重试全部
      </button>
    </div>
  );
}
