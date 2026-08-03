"use client";

import { X } from "lucide-react";

// 全字段详情抽屉（移动端宽表"点行末 ▸ 看全部字段"用）。
// 固定全屏 sheet（inset-0 w-full），与 category-item-drawer 的 w-full md:w-[720px] 同源。
// fields 由各表用自身 formatter 构建（label-value 竖排，tabular-nums 对齐）。
export interface DetailField {
  label: string;
  value: string;
  color?: string; // 可选语义色 className，如 "text-red-600"
}

export function RowDetailDrawer({
  open,
  title,
  fields,
  onClose,
}: {
  open: boolean;
  title: string;
  fields: DetailField[];
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-4">
        <span className="truncate text-sm font-medium text-slate-800">{title}</span>
        <button
          onClick={onClose}
          aria-label="关闭"
          className="text-slate-400 hover:text-slate-700"
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 space-y-1 overflow-auto p-4 text-xs">
        {fields.map((f) => (
          <div
            key={f.label}
            className="flex justify-between gap-3 border-b border-slate-100 py-1.5 tabular-nums"
          >
            <span className="shrink-0 text-slate-500">{f.label}</span>
            <span className={`text-right ${f.color ?? "text-slate-800"}`}>{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
