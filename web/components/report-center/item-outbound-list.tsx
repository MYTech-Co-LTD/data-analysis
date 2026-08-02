"use client";

// 出库商品明细列表（类 Excel 交叉表）：top_category/item_name 筛选 + 服务端分页。
// 首页走 server 预取（initialRows/initialTotal），翻页/筛选走 /api/admin/reports/item-list。
// 交互增强：列排序（客户端，出库降序默认）+ 行点开商品弹层 + 筛选/分页 URL 同步 + 分页图标。
// DESIGN.md：tabular-nums + bordered cross-table + chart-actions 三动作 + lucide 内联图标（size 14, strokeWidth 1.5）。
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { ItemDetailDrawer } from "./item-detail-drawer";
import type { ItemOutboundListRow } from "@/lib/report-center/item-breakdown";

const PAGE_SIZE = 50;
const CATEGORIES = ["水果", "标品", "耗材"] as const;
// 注：原 BRANDS 筛选已移除--dim_item.item_brand 是 manufacturer brand（prod 多为 NULL/脏值），
// 且视图 item_code 粒度跨品牌，该筛选既语义错位又会导致 0 行结果。

// 金额万化（在交叉表里展示），<万 直出整数；null/undefined -> -
function fmtCell(v: number | null | undefined): string {
  if (v == null) return "-";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(0);
}

interface ItemOutboundListProps {
  initialRows: ItemOutboundListRow[];
  initialTotal: number;
  targetId: number;
}

type SortKey = "outbound" | "delivery" | "wholesale" | "name";
type SortDir = "asc" | "desc";

function ItemOutboundListInner({
  initialRows,
  initialTotal,
  targetId,
}: ItemOutboundListProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [rows, setRows] = useState<ItemOutboundListRow[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  // 初始化从 URL 读，刷新后还原筛选/页码
  const [page, setPage] = useState<number>(
    () => Number(searchParams.get("page")) || 1,
  );
  const [filters, setFilters] = useState<{ category: string; q: string }>(
    () => ({
      category: searchParams.get("category") || "",
      q: searchParams.get("q") || "",
    }),
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // 行点开 -> 商品弹层（参考 item-top-boards.tsx drawer 模式）
  const [drawer, setDrawer] = useState<string | null>(null);

  // 客户端列排序（默认出库金额降序）
  const [sortKey, setSortKey] = useState<SortKey>("outbound");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const didMountRef = useRef(false);

  const updateUrl = (p: number, f: { category: string; q: string }) => {
    const params = new URLSearchParams();
    if (f.category) params.set("category", f.category);
    if (f.q) params.set("q", f.q);
    if (p > 1) params.set("page", String(p));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

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
      updateUrl(p, f);
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  // 挂载后：若 URL 带非默认参数（刷新/分享还原），拉对应页。
  // server initialRows 仅 page1/无筛选，故 URL!=defaults 时需补拉一次。
  useEffect(() => {
    if (didMountRef.current) return;
    didMountRef.current = true;
    const urlPage = Number(searchParams.get("page")) || 1;
    const urlCat = searchParams.get("category") || "";
    const urlQ = searchParams.get("q") || "";
    if (urlPage !== 1 || urlCat !== "" || urlQ !== "") {
      void fetchPage(urlPage, { category: urlCat, q: urlQ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFilterChange = (next: typeof filters) => {
    setFilters(next);
    fetchPage(1, next);
  };

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // 数字列默认降序（看大头），商品名默认升序（A-Z）
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  // 客户端排序取值（不 mutate 服务端返回 rows）。默认出库降序。
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
        <ChevronUp size={14} strokeWidth={1.5} />
      ) : (
        <ChevronDown size={14} strokeWidth={1.5} />
      )
    ) : null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleExcel = () => {
    const head = ["商品", "品类", "大类", "配送金额", "批发金额", "出库金额"];
    const body = sortedRows.map((r) => [
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

  // 排序取值（不 mutate 服务端返回 rows）已在 onSort 后定义（sortedRows/sortIcon）。

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
              <th className="px-3 py-2 text-left font-medium">大类</th>
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
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                  加载中…
                </td>
              </tr>
            ) : sortedRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              sortedRows.map((r) => (
                <tr
                  key={r.item_code}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => setDrawer(r.item_code)}
                >
                  <td className="px-3 py-2 text-slate-700">{r.item_name}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.category_name ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.top_category ?? "-"}
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
            onClick={() => fetchPage(page + 1)}
            aria-label="下一页"
            className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
          >
            <ChevronRight size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {drawer && (
        <ItemDetailDrawer
          itemCode={drawer}
          targetId={targetId}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

/**
 * 导出壳：useSearchParams 需 Suspense 边界（Next.js 15 构建期要求）。
 * 页面 [id]/page.tsx 已 `export const dynamic = "force-dynamic"`，运行时服务端正常渲染内层，
 * Suspense 仅作构建安全网（fallback 不会在动态渲染时触发，无首屏闪烁）。
 */
export function ItemOutboundList(props: ItemOutboundListProps) {
  return (
    <Suspense fallback={null}>
      <ItemOutboundListInner {...props} />
    </Suspense>
  );
}
