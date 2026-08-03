"use client";

import { Download, Image as ImageIcon, Share2 } from "lucide-react";
import * as XLSX from "xlsx";

// Excel 导出：传二维数组（含表头）。
export function exportExcel(rows: (string | number)[][], filename: string) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : filename + ".xlsx");
}

// 图片导出：html2canvas 截目标元素，下载 png。html2canvas 动态 import 避免进主 bundle。
export async function exportImage(el: HTMLElement, filename: string) {
  const html2canvas = (await import("html2canvas")).default;
  const canvas = await html2canvas(el, { backgroundColor: "#fff", scale: 2 });
  const link = document.createElement("a");
  link.download = filename.endsWith(".png") ? filename : filename + ".png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// 组件级操作条：Excel / 图片 / 分享。lucide 图标 + 纯文本（DESIGN 禁 emoji）。
// 移动端（isMobile）只渲染 onImage（文案"分享图"），隐 Excel（企微 webview 下 xlsx 体验差）与分享链接
// —— 遵循 DESIGN.md「移动端只生成分享图」。
export function ChartActions({
  onExcel,
  onImage,
  onShare,
  isMobile = false,
}: {
  onExcel?: () => void;
  onImage?: () => void;
  onShare?: () => void;
  isMobile?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 text-xs text-slate-400">
      {!isMobile && onExcel && (
        <button
          onClick={onExcel}
          title="导出 Excel"
          className="flex items-center gap-1 hover:text-slate-700"
        >
          <Download size={14} strokeWidth={1.5} />
          <span>Excel</span>
        </button>
      )}
      {onImage && (
        <button
          onClick={onImage}
          title={isMobile ? "生成分享图" : "导出图片"}
          className="flex items-center gap-1 hover:text-slate-700"
        >
          <ImageIcon size={14} strokeWidth={1.5} />
          <span>{isMobile ? "分享图" : "图片"}</span>
        </button>
      )}
      {!isMobile && onShare && (
        <button
          onClick={onShare}
          title="分享"
          className="flex items-center gap-1 hover:text-slate-700"
        >
          <Share2 size={14} strokeWidth={1.5} />
          <span>分享</span>
        </button>
      )}
    </div>
  );
}
