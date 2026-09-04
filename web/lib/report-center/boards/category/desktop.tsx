"use client";

// web/lib/report-center/boards/category/desktop.tsx
// 类别出库板块渲染适配器：把宿主注入的 BoardProps 映射到 CategorySummary 既有 props（复用，不重写）。
import { CategorySummary } from "@/components/report-center/category-summary";
import type { BoardProps } from "@/lib/contracts";
import type { CategorySummaryRow } from "@/lib/report-center/category-summary";

export function CategoryBoard({
  result,
  target,
  targetMonth,
  targetId,
  progress,
  isMobile,
}: BoardProps<CategorySummaryRow>) {
  const table = (
    <CategorySummary
      result={result}
      targetMonth={targetMonth}
      targetId={targetId}
      progress={progress}
      closed={target.status === "closed"}
      isMobile={isMobile}
    />
  );
  return isMobile ? (
    <div>{table}</div>
  ) : (
    <div className="md:col-span-2">{table}</div>
  );
}
