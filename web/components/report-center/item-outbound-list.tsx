"use client";

// 出库商品明细列表（类 Excel 交叉表）：top_category/item_name 筛选 + 服务端分页。
// 首页走 server 预取（initialRows/initialTotal），翻页/筛选走 /api/admin/reports/item-list。
// DESIGN.md：tabular-nums + bordered cross-table + chart-actions 三动作。
import { useRef, useState } from "react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import type { ItemOutboundListRow } from "@/lib/report-center/item-breakdown";

const PAGE_SIZE = 50;
const CATEGORIES = ["水果", "标品", "耗材"] as const;
// 注：原 BRANDS 筛选已移除——dim_item.item_brand 是 manufacturer brand（prod 多为 NULL/脏值），
// 且视图 item_code 粒度跨品牌，该筛选既语义错位又会导致 0 行结果。

// 金额万化（在交叉表里展示），<万 直出整数；null/undefined → —
function fmtCell(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(0);
}

interface ItemOutboundListProps {
  initialRows: ItemOutboundListRow[];
  initialTotal: number;
  targetId: number;
}

export function ItemOutboundList({ initialRows, initialTotal, targetId }: ItemOutboundListProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ItemOutboundListRow[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [page, setPage] = useState<number>(1);
  const [filters, setFilters] = useState<{ category: string; q: string }>({
    category: "",
    q: "",
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = async (p: number, f = filters) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/reports/item-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, page: p, ...f }),
      }).then((x) => x.json());
      if (r?.ok === false) {
        setError(typeof r.error === "string" ? r.error : "加载失败");
        return;
      }
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setTotal(typeof r?.total === "number" ? r.total : 0);
      setPage(p);
    } catch (e) {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  const onFilterChange = (next: typeof filters) => {
    setFilters(next);
    fetchPage(1, next);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleExcel = () => {
    const head = ["商品", "品类", "大类", "配送金额", "批发金额", "出库金额"];
    const body = rows.map((r) => [
      r.item_name,
      r.category_name ?? "",
      r.top_category ?? "",
      r.delivery_amount,
      r.wholesale_amount,
      r.outbound_amount,
    ]);
    exportExcel([head, ...body], "出库商品明细");
  };

  const handleImage = () => {
    if (tableRef.current) exportImage(tableRef.current, "出库商品明细");
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const { toast } = await import("sonner");
      toast.success("链接已复制");
    } catch {
      /* clipboard 拒绝时静默 */
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">出库商品明细</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
      </div>

      {/* 筛选行 */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={filters.category}
          onChange={(e) => onFilterChange({ ...filters, category: e.target.value })}
          className="rounded border border-slate-200 px-2 py-1 focus:border-blue-500 focus:outline-none"
        >
          <option value="">全品类</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          placeholder="搜商品名"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") fetchPage(1);
          }}
          className="flex-1 rounded border border-slate-200 px-2 py-1 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={() => fetchPage(1)}
          className="rounded bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200"
        >
          搜索
        </button>
      </div>

      <div ref={tableRef} className="max-h-[28rem] overflow-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
              <th className="px-3 py-2 text-left font-medium">商品</th>
              <th className="px-3 py-2 text-left font-medium">品类</th>
              <th className="px-3 py-2 text-left font-medium">大类</th>
              <th className="px-3 py-2 text-right font-medium">配送</th>
              <th className="px-3 py-2 text-right font-medium">批发</th>
              <th className="px-3 py-2 text-right font-medium">出库</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                  加载中…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.item_code} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">{r.item_name}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.category_name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.top_category ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCell(r.delivery_amount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {fmtCell(r.wholesale_amount)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-800">
                    {fmtCell(r.outbound_amount)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

      {/* 分页 */}
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span className="tabular-nums">共 {total} 条</span>
        <div className="flex items-center gap-1">
          <button
            disabled={page <= 1 || loading}
            onClick={() => fetchPage(page - 1)}
            className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
          >
            上一页
          </button>
          <span className="px-2 tabular-nums">
            {page}/{totalPages}
          </span>
          <button
            disabled={page >= totalPages || loading}
            onClick={() => fetchPage(page + 1)}
            className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
