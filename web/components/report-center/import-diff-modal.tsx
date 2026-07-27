"use client";

import { Download } from "lucide-react";
import type { DiffEntry } from "@/lib/report-center/import-diff";

const METRIC_NAME: Record<string, string> = { sale: '销售', delivery: '配送' };

export function ImportDiffModal({
  diffs,
  onConfirm,
  onClose,
}: {
  diffs: DiffEntry[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const changedStores = new Set(diffs.map(d => d.branch_num)).size;
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-w-[92vw] max-h-[80vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-bold text-lg">导入预览</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-sm">取消</button>
        </div>
        <div className="text-sm text-slate-500 mb-3 tabular-nums">
          变更 <b className="text-slate-700">{changedStores}</b> 家门店 / <b className="text-slate-700">{diffs.length}</b> 个值
        </div>
        {diffs.length === 0 ? (
          <div className="text-center text-slate-400 py-8 text-sm">无变更</div>
        ) : (
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead><tr className="bg-slate-50">
              {['门店', '指标', '原值', '新值', '差额'].map(h => <th key={h} className="border border-slate-200 p-2 text-left font-normal">{h}</th>)}
            </tr></thead>
            <tbody>
              {diffs.map((d, i) => (
                <tr key={i}>
                  <td className="border border-slate-200 p-2">{d.branch_name || d.branch_num} <span className="text-xs text-slate-400">{d.branch_num}</span></td>
                  <td className="border border-slate-200 p-2">{METRIC_NAME[d.metric] || d.metric}</td>
                  <td className="border border-slate-200 p-2 text-right">{d.oldValue.toLocaleString()}</td>
                  <td className="border border-slate-200 p-2 text-right">{d.newValue.toLocaleString()}</td>
                  <td className={`border border-slate-200 p-2 text-right ${d.diff > 0 ? 'text-green-600' : 'text-red-600'}`}>{d.diff > 0 ? '+' : ''}{d.diff.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end gap-2 pt-3 border-t mt-3">
          <button onClick={onClose} className="border border-slate-300 px-4 py-1 text-sm rounded-md hover:bg-slate-50">取消</button>
          <button onClick={onConfirm} disabled={diffs.length === 0} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Download size={14} /> 确认覆盖
          </button>
        </div>
      </div>
    </div>
  );
}
