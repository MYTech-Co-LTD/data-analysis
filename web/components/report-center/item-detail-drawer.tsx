"use client";

// 商品弹层：日趋势（销售+出库聚合到日）+ 品牌分布 + 类别卡。
// 数据走 /api/admin/reports/item-detail（get_item_detail RPC + dim_item meta）。
// 品牌显示仅做标签映射（3120→熊喵鲜生 / 64188→品品甜），非生成器代码。
import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface Daily {
  biz_date: string;
  system_book_code: string;
  sale_amount: number | string | null;
  outbound_amount: number | string | null;
}

interface Meta {
  item_name: string | null;
  category_name: string | null;
  top_category: string | null;
  item_brand: string | null;
  system_book_code: string | null;
}

// 品牌码→品牌名（仅展示层映射，非生成器/config 字面量）
function brandLabel(code: string): string {
  if (code === "3120") return "熊喵鲜生";
  if (code === "64188") return "品品甜";
  return code;
}

function fmtWan(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

interface ItemDetailDrawerProps {
  itemCode: string;
  targetId: number;
  onClose: () => void;
}

export function ItemDetailDrawer({ itemCode, targetId, onClose }: ItemDetailDrawerProps) {
  const [daily, setDaily] = useState<Daily[]>([]);
  const [meta, setMeta] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    (async () => {
      try {
        const r = await fetch("/api/admin/reports/item-detail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_id: targetId, item_code: itemCode }),
        }).then((x) => x.json());
        if (cancelled) return;
        if (r?.ok === false) {
          setErrorMsg(typeof r.error === "string" ? r.error : "加载失败");
        } else {
          setDaily(Array.isArray(r?.daily) ? r.daily : []);
          setMeta(Array.isArray(r?.meta) ? r.meta : []);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg("网络错误");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [itemCode, targetId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 品牌分布聚合
  const byBrand = daily.reduce<Record<string, { sale: number; out: number }>>((m, d) => {
    const k = d.system_book_code;
    if (!k) return m;
    if (!m[k]) m[k] = { sale: 0, out: 0 };
    m[k].sale += Number(d.sale_amount || 0);
    m[k].out += Number(d.outbound_amount || 0);
    return m;
  }, {});

  // 日趋势：聚合到日（跨品牌合并），便于干净的趋势条
  const byDate = daily.reduce<Record<string, number>>((m, d) => {
    const k = d.biz_date;
    if (!k) return m;
    if (!m[k]) m[k] = 0;
    m[k] += Number(d.sale_amount || 0);
    return m;
  }, {});
  const dateKeys = Object.keys(byDate).sort();
  const maxSale = dateKeys.reduce((mx, k) => Math.max(mx, byDate[k]), 0);

  const m = meta[0];
  const title = m?.item_name ?? itemCode;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="h-full w-[480px] max-w-[92vw] overflow-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800" title={title}>
            {title}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-slate-400">加载中…</div>
        ) : errorMsg ? (
          <div className="py-8 text-center text-sm text-red-600">{errorMsg}</div>
        ) : (
          <>
            {/* 类别卡 */}
            <div className="mb-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded bg-slate-50 p-2">
                <div className="text-slate-500">品类</div>
                <div className="truncate font-medium text-slate-700" title={m?.category_name ?? ""}>
                  {m?.category_name ?? "—"}
                </div>
              </div>
              <div className="rounded bg-slate-50 p-2">
                <div className="text-slate-500">大类</div>
                <div className="truncate font-medium text-slate-700" title={m?.top_category ?? ""}>
                  {m?.top_category ?? "—"}
                </div>
              </div>
              <div className="rounded bg-slate-50 p-2">
                <div className="text-slate-500">品牌</div>
                <div className="truncate font-medium text-slate-700" title={m?.item_brand ?? ""}>
                  {m?.item_brand ?? "—"}
                </div>
              </div>
            </div>

            {/* 品牌分布 */}
            <div className="mb-4">
              <div className="mb-1 text-xs text-slate-500">品牌分布</div>
              {Object.keys(byBrand).length === 0 ? (
                <div className="py-2 text-xs text-slate-400">无品牌数据</div>
              ) : (
                Object.entries(byBrand).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 py-1 text-sm tabular-nums">
                    <span className="w-20 shrink-0 truncate text-slate-600" title={brandLabel(k)}>
                      {brandLabel(k)}
                    </span>
                    <span className="flex-1 text-slate-700">
                      销售 {fmtWan(v.sale)} · 出库 {fmtWan(v.out)}
                    </span>
                  </div>
                ))
              )}
            </div>

            {/* 日趋势条 */}
            <div>
              <div className="mb-1 text-xs text-slate-500">日销售趋势（{dateKeys.length} 日）</div>
              {dateKeys.length === 0 ? (
                <div className="py-2 text-xs text-slate-400">无日趋势数据</div>
              ) : (
                <div className="flex h-32 items-end gap-px">
                  {dateKeys.map((k) => {
                    const v = byDate[k];
                    const h = maxSale > 0 ? Math.max(2, (v / maxSale) * 100) : 0;
                    return (
                      <div
                        key={k}
                        className="flex-1 bg-blue-400 hover:bg-blue-600"
                        style={{ height: `${h}%` }}
                        title={`${k}: ${fmtWan(v)}`}
                      />
                    );
                  })}
                </div>
              )}
              {dateKeys.length > 0 && (
                <div className="mt-1 flex justify-between text-[10px] text-slate-400 tabular-nums">
                  <span>{dateKeys[0]}</span>
                  <span>{dateKeys[dateKeys.length - 1]}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
