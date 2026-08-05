"use client";

// 供应链出库三级下钻表（参考 RegionDrillTable 交互模式）。
// 数据：SupplyChainOutboundRow[]（level=region/sub_region/store，视图三级 UNION ALL）。
// 下钻：默认 4 个 region 行；点 region 展开 sub_region；点 sub_region 展开 store。
// 末行合计：只 SUM level='store'（跨级 SUM 会 3x）。
// 标红：store 级行 delivery_margin < 0.12（12%）整行标红（背景淡红 + 数字深红）。
// 脱敏：profit/margin 为 NULL 显示「-」；margin 是 0-1 小数（×100 显示百分比）。
// DESIGN.md：tabular-nums + 类 Excel 交叉表 + chart-actions 三动作。
import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SupplyChainOutboundRow } from "@/lib/report-center/supply-chain-outbound";
import type { GetterResult } from "@/lib/report-center/types";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { MaskedBadge } from "./masked-badge";
import { ModuleError } from "./module-error";
import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";
import { useCanSeeCost } from "./use-can-see-cost";

interface SupplyChainOutboundTableProps {
  result: GetterResult<SupplyChainOutboundRow>;
  startDate: string;
  endDate: string;
  targetId: number; // 预留（任务要求 props 含此字段，纯展示组件当前未直接使用）
  isMobile?: boolean;
}

// 金额格式化：≥10000 用「X.X万」，否则整数，¥ 前缀（与 item-top-boards 对齐）
function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}
// 利润格式化：NULL 脱敏显示「-」，否则 fmtCurrency（负数亏损正常显示）
function fmtProfit(v: number | null): string {
  return v == null ? "-" : fmtCurrency(v);
}
// 毛利率：NULL 脱敏「-」，否则 ×100 保留 1 位 + %
function fmtMargin(m: number | null): string {
  return m == null ? "-" : `${(m * 100).toFixed(1)}%`;
}
// 标题命名：{sM}月{sD}日-{eM}月{eD}日{suffix}
function fmtRangeTitle(start: string, end: string, suffix: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日${suffix}`;
}

interface TreeNode {
  code: string;
  name: string;
  level: "region" | "sub_region" | "store";
  children: TreeNode[];
  data: SupplyChainOutboundRow;
}

// 低毛利阈值：store 级行 delivery_margin < 12% 整行标红
const LOW_MARGIN_THRESHOLD = 0.12;

export function SupplyChainOutboundTable({
  result,
  startDate,
  endDate,
  isMobile = false,
}: SupplyChainOutboundTableProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  // F2.3: costMasked=true 时所有 profit/margin 列头挂角标（出库毛利/毛利率/当天出库毛利/当天毛利率）
  const costMasked = !useCanSeeCost();

  // 构建三级树：region -> sub_region -> store
  // parent_code 链：region=NULL / sub_region=region_code(=war_zone) / store=sub_region_code(=region_l2)
  const tree = useMemo(() => {
    const regionMap = new Map<string, TreeNode>();
    const subRegionMap = new Map<string, TreeNode>();

    // region 级
    for (const r of rows) {
      if (r.level === "region") {
        regionMap.set(r.region_code, {
          code: r.region_code,
          name: r.region_name,
          level: "region",
          children: [],
          data: r,
        });
      }
    }
    // sub_region 级
    for (const r of rows) {
      if (r.level === "sub_region" && r.parent_code) {
        const node: TreeNode = {
          code: r.sub_region_code!,
          name: r.sub_region_name!,
          level: "sub_region",
          children: [],
          data: r,
        };
        subRegionMap.set(r.sub_region_code!, node);
        const parent = regionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }
    // store 级
    for (const r of rows) {
      if (r.level === "store" && r.parent_code) {
        const node: TreeNode = {
          code: r.branch_num!,
          name: r.branch_name!,
          level: "store",
          children: [],
          data: r,
        };
        const parent = subRegionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }
    // 排序：sub_region/store 按出库金额降序
    for (const sr of subRegionMap.values()) {
      sr.children.sort((a, b) => b.data.delivery_amount - a.data.delivery_amount);
    }
    for (const r of regionMap.values()) {
      r.children.sort((a, b) => b.data.delivery_amount - a.data.delivery_amount);
    }
    return [...regionMap.values()].sort(
      (a, b) => b.data.delivery_amount - a.data.delivery_amount,
    );
  }, [rows]);

  const toggleExpand = (code: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // 扁平化可见行：只含已展开节点的子孙（与 RegionDrillTable 同款）
  // key 用 level-parent-code 全局唯一（store 的 branch_num 跨 sub_region 可能重复，须复合）
  const flatRows = useMemo(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        if (n.children.length > 0 && expandedNodes.has(n.code)) {
          walk(n.children, depth + 1);
        }
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expandedNodes]);

  // 末行合计：只 SUM level='store'（视图三级 UNION ALL，跨级 SUM 会 3x）
  // margin = 合计 profit / 合计 amount（前端算）；profit 全脱敏时显示「-」
  const totals = useMemo(() => {
    let amount = 0;
    let profitSum = 0;
    let hasProfit = false;
    let dailyAmount = 0;
    let dailyProfitSum = 0;
    let hasDailyProfit = false;
    for (const r of rows) {
      if (r.level === "store") {
        amount += r.delivery_amount;
        if (r.delivery_profit != null) {
          profitSum += r.delivery_profit;
          hasProfit = true;
        }
        dailyAmount += r.daily_delivery_amount;
        if (r.daily_delivery_profit != null) {
          dailyProfitSum += r.daily_delivery_profit;
          hasDailyProfit = true;
        }
      }
    }
    const profit = hasProfit ? profitSum : null;
    const dailyProfit = hasDailyProfit ? dailyProfitSum : null;
    return {
      amount,
      profit,
      margin: amount > 0 && profit != null ? profit / amount : null,
      dailyAmount,
      dailyProfit,
      dailyMargin:
        dailyAmount > 0 && dailyProfit != null ? dailyProfit / dailyAmount : null,
    };
  }, [rows]);

  const title = fmtRangeTitle(startDate, endDate, "供应链出库数据报表");

  // 移动端：点行末 ▸ 看该行全字段（6 列 label-value）
  const [detailNode, setDetailNode] = useState<TreeNode | null>(null);
  function buildSupplyFields(d: SupplyChainOutboundRow): DetailField[] {
    // store 级低毛利行：抽屉内全部数字字段标红，与桌面整行 numColor 语义一致
    const lowMargin =
      d.level === "store" &&
      d.delivery_margin != null &&
      d.delivery_margin < LOW_MARGIN_THRESHOLD;
    const numColor = lowMargin ? "text-red-600" : undefined;
    return [
      { label: "出库金额", value: fmtCurrency(d.delivery_amount), color: numColor },
      { label: "出库毛利", value: fmtProfit(d.delivery_profit), color: numColor },
      { label: "毛利率", value: fmtMargin(d.delivery_margin), color: numColor },
      { label: "当天出库金额", value: fmtCurrency(d.daily_delivery_amount), color: numColor },
      { label: "当天出库毛利", value: fmtProfit(d.daily_delivery_profit), color: numColor },
      { label: "当天毛利率", value: fmtMargin(d.daily_delivery_margin), color: numColor },
    ];
  }

  const handleExcel = () => {
    // 扁平化当前可见行（含已展开子孙），导出原始数值 + 合计行
    const flat: SupplyChainOutboundRow[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        flat.push(node.data);
        if (expandedNodes.has(node.code)) flatten(node.children);
      }
    };
    flatten(tree);
    const head = [
      "名称",
      "出库金额",
      "出库毛利",
      "毛利率",
      "当天出库金额",
      "当天出库毛利",
      "当天毛利率",
    ];
    const body: (string | number)[][] = flat.map((r) => {
      const name =
        r.level === "region"
          ? r.region_name
          : r.level === "sub_region"
            ? (r.sub_region_name ?? "")
            : (r.branch_name ?? "");
      return [
        name,
        r.delivery_amount,
        r.delivery_profit ?? "",
        r.delivery_margin != null ? fmtMargin(r.delivery_margin) : "",
        r.daily_delivery_amount,
        r.daily_delivery_profit ?? "",
        r.daily_delivery_margin != null ? fmtMargin(r.daily_delivery_margin) : "",
      ];
    });
    body.push([
      "合计",
      totals.amount,
      totals.profit ?? "",
      totals.margin != null ? fmtMargin(totals.margin) : "",
      totals.dailyAmount,
      totals.dailyProfit ?? "",
      totals.dailyMargin != null ? fmtMargin(totals.dailyMargin) : "",
    ]);
    exportExcel([head, ...body], title);
  };

  const handleImage = () => {
    if (tableRef.current) exportImage(tableRef.current, title);
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

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={`供应链出库报表加载失败${error?.message ? `（${error.message}）` : ""}`}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} isMobile={isMobile} />
      </div>

      {/* 桌面：7 列宽表（原样不动） */}
      {!isMobile && (
        <div ref={tableRef} className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-3 py-2 text-left font-medium">大区名称</th>
                <th className="px-3 py-2 text-right font-medium">出库金额</th>
                <th className="px-3 py-2 text-right font-medium">
                  出库毛利{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  毛利率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">当天出库金额</th>
                <th className="px-3 py-2 text-right font-medium">
                  当天出库毛利{costMasked && <MaskedBadge />}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  当天毛利率{costMasked && <MaskedBadge />}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 24;
                const isStore = node.level === "store";
                const lowMargin =
                  isStore &&
                  node.data.delivery_margin != null &&
                  node.data.delivery_margin < LOW_MARGIN_THRESHOLD;
                const rowBg = lowMargin ? "bg-red-50" : "hover:bg-slate-50";
                const numColor = lowMargin ? "text-red-600" : "text-slate-700";
                return (
                  <tr
                    key={`${node.level}-${node.data.parent_code || "root"}-${node.code}`}
                    className={rowBg}
                  >
                    <td
                      className="px-3 py-2 text-slate-700"
                      style={{
                        paddingLeft: `${indent + 12}px`,
                        cursor: hasChildren ? "pointer" : "default",
                      }}
                      onClick={hasChildren ? () => toggleExpand(node.code) : undefined}
                    >
                      {hasChildren && (
                        <span className="mr-1 inline-flex h-4 w-4 items-center justify-center text-slate-400">
                          {isExpanded ? (
                            <ChevronDown size={14} strokeWidth={1.5} />
                          ) : (
                            <ChevronRight size={14} strokeWidth={1.5} />
                          )}
                        </span>
                      )}
                      <span className={depth === 0 ? "font-semibold" : ""}>
                        {node.name}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtCurrency(node.data.delivery_amount)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtProfit(node.data.delivery_profit)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtMargin(node.data.delivery_margin)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtCurrency(node.data.daily_delivery_amount)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtProfit(node.data.daily_delivery_profit)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtMargin(node.data.daily_delivery_margin)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/50 font-medium text-slate-700">
                <td className="px-3 py-2 text-left">合计</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.amount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtProfit(totals.profit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMargin(totals.margin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCurrency(totals.dailyAmount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtProfit(totals.dailyProfit)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMargin(totals.dailyMargin)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 移动：精简 4 列（名称 · 出库金额 · 毛利率 · 当天出库）+ 行末 ▸ 看全字段。
          树 chevron（左）展开子级，▸（右）开全字段抽屉，两个独立 tap 区。
          store 级 delivery_margin < 0.12 整行标红（与桌面一致）。 */}
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">名称</th>
                <th className="px-2 py-2 text-right font-medium">出库金额</th>
                <th className="px-2 py-2 text-right font-medium">
                  毛利率{costMasked && <MaskedBadge />}
                </th>
                <th className="px-2 py-2 text-right font-medium">当天出库</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 16;
                const isStore = node.level === "store";
                const lowMargin =
                  isStore &&
                  node.data.delivery_margin != null &&
                  node.data.delivery_margin < LOW_MARGIN_THRESHOLD;
                const numColor = lowMargin ? "text-red-600" : "text-slate-700";
                return (
                  <tr
                    key={`${node.level}-${node.data.parent_code || "root"}-${node.code}`}
                    className={lowMargin ? "bg-red-50" : ""}
                  >
                    <td className="px-2 py-2 text-slate-700" style={{ paddingLeft: `${indent + 8}px` }}>
                      <div className="flex items-center gap-1">
                        {hasChildren ? (
                          <button
                            onClick={() => toggleExpand(node.code)}
                            aria-label="展开子级"
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-slate-400"
                          >
                            {isExpanded ? (
                              <ChevronDown size={16} strokeWidth={1.5} />
                            ) : (
                              <ChevronRight size={16} strokeWidth={1.5} />
                            )}
                          </button>
                        ) : null}
                        <span className={`truncate ${depth === 0 ? "font-semibold" : ""}`}>
                          {node.name}
                        </span>
                      </div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtCurrency(node.data.delivery_amount)}
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtMargin(node.data.delivery_margin)}
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${numColor}`}>
                      {fmtCurrency(node.data.daily_delivery_amount)}
                    </td>
                    <td className="px-1 py-2 text-right">
                      <button
                        onClick={() => setDetailNode(node)}
                        aria-label="查看全部字段"
                        className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700"
                      >
                        <ChevronRight size={16} strokeWidth={1.5} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RowDetailDrawer
        open={!!detailNode}
        title={detailNode?.name ?? ""}
        fields={detailNode ? buildSupplyFields(detailNode.data) : []}
        onClose={() => setDetailNode(null)}
      />
    </div>
  );
}
