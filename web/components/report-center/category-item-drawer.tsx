"use client";

// 品类下钻抽屉：点品类看板某品类行弹出，显示该品类商品明细。
// 取数 /api/admin/reports/item-list（lib 已按 category_group 筛，修了 top_category 0 行 bug）。
// 无 URL 同步（抽屉本地态，避免污染主看板 URL）。行点开 -> ItemDetailDrawer（现有）。
import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Search, Loader2 } from "lucide-react";
import { ItemDetailDrawer } from "./item-detail-drawer";
import type { ItemOutboundListRow } from "@/lib/report-center/item-breakdown";

const PAGE_SIZE = 50;

function fmtCell(v: number | null | undefined): string {
  if (v == null) return "-";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(0);
}

type SortKey = "outbound" | "delivery" | "wholesale" | "name";
type SortDir = "asc" | "desc";

interface Props {
  targetId: number;
  category: string;
  onClose: () => void;
}

export function CategoryItemDrawer({ targetId, category, onClose }: Props) {
  const [rows, setRows] = useState<ItemOutboundListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerItem, setDrawerItem] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("outbound");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const fetchPage = async (p: number, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/reports/item-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, page: p, category, q: query }),
      }).then((x) => x.json());
      if (r?.ok === false) {
        setError(typeof r.error === "string" ? r.error : "加载失败");
        return;
      }
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setTotal(typeof r?.total === "number" ? r.total : 0);
      setPage(p);
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  // 切品类/目标时重拉首页
  useEffect(() => {
    setQ("");
    setQInput("");
    fetchPage(1, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, targetId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };
  const getSortVal = (r: ItemOutboundListRow): number | string => {
    if (sortKey === "name") return r.item_name;
    if (sortKey === "outbound") return r.outbound_amount;
    if (sortKey === "delivery") return r.delivery_amount;
    return r.wholesale_amount;
  };
  const sortedRows = [...rows].sort((a, b) => {
    const av = getSortVal(a);
    const bv = getSortVal(b);
    if (typeof av === "string" || typeof bv === "string") {
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return sortDir === "asc" ? av - bv : bv - av;
  });
  const sortIcon = (k: SortKey) =>
    sortKey === k ? (
      sortDir === "asc" ? (
        <ChevronUp size={13} strokeWidth={1.5} />
      ) : (
        <ChevronDown size={13} strokeWidth={1.5} />
      )
    ) : null;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-full w-[720px] max-w-[94vw] flex-col overflow-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">
            {category} · 商品明细
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* 搜索 */}
        <div className="mb-2 flex items-center gap-2 text-xs">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setQ(qInput);
                  fetchPage(1, qInput);
                }
              }}
              placeholder="搜商品名"
              className="w-full rounded border border-slate-200 py-1 pl-7 pr-2 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => {
              setQ(qInput);
              fetchPage(1, qInput);
            }}
            className="rounded bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200"
          >
            搜索
          </button>
        </div>

        {/* 表 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
              <tr>
                <th
                  onClick={() => onSort("name")}
                  className="cursor-pointer select-none px-3 py-2 text-left font-medium hover:text-slate-700"
                >
                  <span className="inline-flex items-center gap-1">
                    商品
                    {sortIcon("name")}
                  </span>
                </th>
                <th className="px-3 py-2 text-left font-medium">品类</th>
                <th
                  onClick={() => onSort("delivery")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    配送
                    {sortIcon("delivery")}
                  </span>
                </th>
                <th
                  onClick={() => onSort("wholesale")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    批发
                    {sortIcon("wholesale")}
                  </span>
                </th>
                <th
                  onClick={() => onSort("outbound")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    出库
                    {sortIcon("outbound")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                    <Loader2 size={14} className="mr-1 inline animate-spin" />
                    加载中…
                  </td>
                </tr>
              ) : sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                sortedRows.map((r) => (
                  <tr
                    key={r.item_code}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setDrawerItem(r.item_code)}
                  >
                    <td className="px-3 py-2 text-slate-700">{r.item_name}</td>
                    <td className="px-3 py-2 text-slate-700">{r.category_name ?? "-"}</td>
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
              onClick={() => fetchPage(page - 1, q)}
              aria-label="上一页"
              className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
            >
              <ChevronLeft size={14} strokeWidth={1.5} />
            </button>
            <span className="px-2 tabular-nums">
              {page}/{totalPages}
            </span>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => fetchPage(page + 1, q)}
              aria-label="下一页"
              className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
            >
              <ChevronRight size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>

      {drawerItem && (
        <ItemDetailDrawer
          itemCode={drawerItem}
          targetId={targetId}
          onClose={() => setDrawerItem(null)}
        />
      )}
    </div>
  );
}
