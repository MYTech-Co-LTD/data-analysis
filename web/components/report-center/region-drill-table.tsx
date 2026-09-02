"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import type { GetterResult } from "@/lib/report-center/types";
import { actualRatio, targetRatio, ratioAchievement, formatRatio, absoluteThreeColor } from "@/lib/report-center/ratio";
import {
  isSuspiciousAmount,
  isSuspiciousRate,
  isSuspiciousMargin,
  suspiciousClass,
  suspiciousTitle,
  amountsClose,
  numMatch,
  sumField,
} from "@/lib/report-center/guard";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { TotalAnomalyBadge } from "./data-guard-badges";
import { ModuleError, formatModuleError } from "./module-error";
import { RowDetailDrawer, type DetailField } from "./row-detail-drawer";

interface RegionDrillTableProps {
  result: GetterResult<RegionBreakdownRow>;
  targetMonth: number;
  progress: number; // 时间进度，如 0.677
  /** 目标已结束（closed）：「当天/剩余日均」语义失效，列值/抽屉/导出统一显示 "—" */
  closed?: boolean;
  isMobile?: boolean;
}

// 达成率三色编码（对齐 KPI 比率带）：按「达成率 / 时间进度」对比着色（相对进度）：
//   >=1   → success #16A34A（跑赢进度）
//   >=0.8 → warning #D97706（接近）
//   <0.8  → error #DC2626（落后）
// NULL rate → 灰（无数据/脱敏）；progress=0 → 除 0.0001 兜底。
function rateColor(rate: number | null, progress: number): string {
  if (rate == null) return "text-slate-300";
  const ratio = (rate ?? 0) / (progress || 0.0001);
  return ratio >= 1 ? "text-green-600" : ratio >= 0.8 ? "text-amber-600" : "text-red-600";
}

function fmtCurrency(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

interface TreeNode {
  code: string;
  name: string;
  level: 'region' | 'sub_region' | 'store';
  children: TreeNode[];
  data: RegionBreakdownRow;
}

export function RegionDrillTable({ result, targetMonth, progress, closed = false, isMobile = false }: RegionDrillTableProps) {
  const { rows, status, error } = result;
  const tableRef = useRef<HTMLDivElement>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // closed 目标「当天/剩余日均」无意义（2026-09-02 用户裁定）：列值/抽屉/导出统一 "—"，
  // 可疑着色与角标一并关闭；数据行保持原值（F3 合计自洽对账不受影响）。
  // dRaw 供 Excel 用（导出保持原始数值，仅 closed 时掩 "—"）；dVal 是表格单元格格式化。
  const dVal = (v: number | null | undefined) => (closed ? "—" : fmtCurrency(v));
  const dRaw = (v: number) => (closed ? "—" : v);
  const dCls = (susp: boolean) => (closed ? "" : suspiciousClass(susp, "text-slate-700"));
  const dTitle = (susp: boolean) => (closed ? undefined : suspiciousTitle(susp));

  // 构建树形结构
  const tree = useMemo(() => {
    const regionMap = new Map<string, TreeNode>();
    const subRegionMap = new Map<string, TreeNode>();

    for (const r of rows) {
      if (r.level === 'region') {
        regionMap.set(r.region_code, { code: r.region_code, name: r.region_name, level: 'region', children: [], data: r });
      }
    }
    for (const r of rows) {
      if (r.level === 'sub_region' && r.parent_code) {
        const node: TreeNode = { code: r.sub_region_code!, name: r.sub_region_name!, level: 'sub_region', children: [], data: r };
        subRegionMap.set(r.sub_region_code!, node);
        const parent = regionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }
    for (const r of rows) {
      if (r.level === 'store' && r.parent_code) {
        const node: TreeNode = { code: r.branch_num!, name: r.branch_name!, level: 'store', children: [], data: r };
        const parent = subRegionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }
    for (const sr of subRegionMap.values()) sr.children.sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
    for (const r of regionMap.values()) r.children.sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
    return [...regionMap.values()].sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
  }, [rows]);

  const toggleExpand = (code: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // 扁平化"可见行"：只含已展开节点的子孙。useMemo 依赖 tree+expandedNodes，比递归 spread 稳。
  // key 用 level-parent-code 全局唯一（store 的 branch_num 跨 sub_region 重复，须复合）。
  const flatRows = useMemo(() => {
    const out: { node: TreeNode; depth: number }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        if (n.children.length > 0 && expandedNodes.has(n.code)) walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expandedNodes]);

  // F3 合计自洽（层级视图无合计行）：用 level='store' 行 SUM 作基准，校验 = 各 region 行之和
  const totalAnomaly = useMemo(() => {
    const regionRows = rows.filter((r) => r.level === "region");
    const storeRows = rows.filter((r) => r.level === "store");
    if (regionRows.length === 0 || storeRows.length === 0) return false;
    const s = (rs: RegionBreakdownRow[], pick: (r: RegionBreakdownRow) => number) =>
      sumField(rs, pick);
    return !(
      numMatch(s(storeRows, (r) => r.sale_target), s(regionRows, (r) => r.sale_target), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.sale_actual), s(regionRows, (r) => r.sale_actual), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.delivery_target), s(regionRows, (r) => r.delivery_target), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.delivery_actual), s(regionRows, (r) => r.delivery_actual), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.daily_sale), s(regionRows, (r) => r.daily_sale), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.daily_delivery), s(regionRows, (r) => r.daily_delivery), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.remaining_daily_sale_target), s(regionRows, (r) => r.remaining_daily_sale_target), 1, amountsClose) &&
      numMatch(s(storeRows, (r) => r.remaining_daily_delivery_target), s(regionRows, (r) => r.remaining_daily_delivery_target), 1, amountsClose)
    );
  }, [rows]);

  // 移动端：点行末 ▸ 看该行全字段（13 列 label-value）
  const [detailNode, setDetailNode] = useState<TreeNode | null>(null);

  function buildRegionFields(d: RegionBreakdownRow): DetailField[] {
    return [
      { label: "月销售目标", value: fmtCurrency(d.sale_target), color: suspiciousClass(isSuspiciousAmount(d.sale_target), "text-slate-800") },
      { label: "月销售金额", value: fmtCurrency(d.sale_actual), color: suspiciousClass(isSuspiciousAmount(d.sale_actual), "text-slate-800") },
      { label: "月销售完成率", value: fmtRate(d.sale_rate), color: suspiciousClass(isSuspiciousRate(d.sale_rate), rateColor(d.sale_rate, progress)) },
      { label: "月配送目标", value: fmtCurrency(d.delivery_target), color: suspiciousClass(isSuspiciousAmount(d.delivery_target), "text-slate-800") },
      { label: "月配送金额", value: fmtCurrency(d.delivery_actual), color: suspiciousClass(isSuspiciousAmount(d.delivery_actual), "text-slate-800") },
      { label: "月配送完成率", value: fmtRate(d.delivery_rate), color: suspiciousClass(isSuspiciousRate(d.delivery_rate), rateColor(d.delivery_rate, progress)) },
      { label: "当天销售金额", value: dVal(d.daily_sale), color: dCls(isSuspiciousAmount(d.daily_sale)) },
      { label: "当天配送金额", value: dVal(d.daily_delivery), color: dCls(isSuspiciousAmount(d.daily_delivery)) },
      { label: "剩余日均销售目标", value: dVal(d.remaining_daily_sale_target), color: dCls(isSuspiciousAmount(d.remaining_daily_sale_target)) },
      { label: "剩余日均配送目标", value: dVal(d.remaining_daily_delivery_target), color: dCls(isSuspiciousAmount(d.remaining_daily_delivery_target)) },
      { label: "配销比目标", value: formatRatio(targetRatio(d.delivery_target, d.sale_target)), color: suspiciousClass(isSuspiciousMargin(targetRatio(d.delivery_target, d.sale_target)), "text-slate-800") },
      { label: "配销比", value: formatRatio(actualRatio(d.delivery_actual, d.sale_actual)), color: suspiciousClass(isSuspiciousMargin(actualRatio(d.delivery_actual, d.sale_actual)), absoluteThreeColor(ratioAchievement(d.delivery_actual, d.sale_actual, d.delivery_target, d.sale_target))) },
    ];
  }

  const handleExcel = () => {
    const flatRowsData: RegionBreakdownRow[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        flatRowsData.push(node.data);
        if (expandedNodes.has(node.code)) flatten(node.children);
      }
    };
    flatten(tree);
    const head = ["大区名称", "小区名称", "门店名称", "月销售目标", "月销售金额", "月销售完成率", "月配送目标", "月配送金额", "月配送完成率", "当天销售金额", "当天配送金额", "剩余日均销售目标", "剩余日均配送目标", "配销比目标", "配销比"];
    const body = flatRowsData.map((r) => [r.region_name, r.sub_region_name ?? "", r.branch_name ?? "", r.sale_target, r.sale_actual, fmtRate(r.sale_rate), r.delivery_target, r.delivery_actual, fmtRate(r.delivery_rate), dRaw(r.daily_sale), dRaw(r.daily_delivery), dRaw(r.remaining_daily_sale_target), dRaw(r.remaining_daily_delivery_target), formatRatio(targetRatio(r.delivery_target, r.sale_target)), formatRatio(actualRatio(r.delivery_actual, r.sale_actual))]);
    exportExcel([head, ...body], `${targetMonth}月门店零售配送数据报表`);
  };

  const handleImage = () => { if (tableRef.current) exportImage(tableRef.current, `${targetMonth}月门店零售配送报表`); };
  const handleShare = async () => {
    try { await navigator.clipboard.writeText(window.location.href); const { toast } = await import('sonner'); toast.success('链接已复制'); } catch { /* 剪贴板拒绝时静默 */ }
  };

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <ModuleError
          message={formatModuleError("门店零售/配送报表加载失败", error)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {targetMonth}月门店零售/配送数据报表
          {totalAnomaly && <TotalAnomalyBadge />}
        </h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} isMobile={isMobile} />
      </div>

      {/* 桌面：13 列宽表（原样不动） */}
      {!isMobile && (
        <div ref={tableRef} className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-3 py-2 text-left font-medium">大区名称</th>
                <th className="px-3 py-2 text-right font-medium">月销售目标</th>
                <th className="px-3 py-2 text-right font-medium">月销售金额</th>
                <th className="px-3 py-2 text-right font-medium">月销售完成率</th>
                <th className="px-3 py-2 text-right font-medium">月配送目标</th>
                <th className="px-3 py-2 text-right font-medium">月配送金额</th>
                <th className="px-3 py-2 text-right font-medium">月配送完成率</th>
                <th className="px-3 py-2 text-right font-medium">当天销售金额</th>
                <th className="px-3 py-2 text-right font-medium">当天配送金额</th>
                <th className="px-3 py-2 text-right font-medium">剩余日均销售目标</th>
                <th className="px-3 py-2 text-right font-medium">剩余日均配送目标</th>
                <th className="px-3 py-2 text-right font-medium">配销比目标</th>
                <th className="px-3 py-2 text-right font-medium">配销比</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr><td colSpan={13} className="px-3 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 24;
                // F4: 该行各字段是否「可疑」
                const d = node.data;
                const s = {
                  saleTarget: isSuspiciousAmount(d.sale_target),
                  saleActual: isSuspiciousAmount(d.sale_actual),
                  saleRate: isSuspiciousRate(d.sale_rate),
                  deliveryTarget: isSuspiciousAmount(d.delivery_target),
                  deliveryActual: isSuspiciousAmount(d.delivery_actual),
                  deliveryRate: isSuspiciousRate(d.delivery_rate),
                  dailySale: isSuspiciousAmount(d.daily_sale),
                  dailyDelivery: isSuspiciousAmount(d.daily_delivery),
                  remainingSale: isSuspiciousAmount(d.remaining_daily_sale_target),
                  remainingDelivery: isSuspiciousAmount(d.remaining_daily_delivery_target),
                  ratioTarget: isSuspiciousMargin(targetRatio(d.delivery_target, d.sale_target)),
                  ratioActual: isSuspiciousMargin(actualRatio(d.delivery_actual, d.sale_actual)),
                };
                return (
                  <tr key={`${node.level}-${node.data.parent_code || 'root'}-${node.code}`} className="hover:bg-slate-50">
                    <td
                      className="px-3 py-2 text-slate-700"
                      style={{ paddingLeft: `${indent + 12}px`, cursor: hasChildren ? 'pointer' : 'default' }}
                      onClick={hasChildren ? () => toggleExpand(node.code) : undefined}
                    >
                      {hasChildren && (
                        <span className="mr-1 inline-flex items-center justify-center w-4 h-4 text-slate-400">
                          {isExpanded ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
                        </span>
                      )}
                      <span className={depth === 0 ? "font-semibold" : ""}>{node.name}</span>
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleTarget, "text-slate-700")}`} title={suspiciousTitle(s.saleTarget)}>{fmtCurrency(node.data.sale_target)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleActual, "text-slate-700")}`} title={suspiciousTitle(s.saleActual)}>{fmtCurrency(node.data.sale_actual)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.saleRate, rateColor(node.data.sale_rate, progress))}`} title={suspiciousTitle(s.saleRate)}>{fmtRate(node.data.sale_rate)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryTarget, "text-slate-700")}`} title={suspiciousTitle(s.deliveryTarget)}>{fmtCurrency(node.data.delivery_target)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryActual, "text-slate-700")}`} title={suspiciousTitle(s.deliveryActual)}>{fmtCurrency(node.data.delivery_actual)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryRate, rateColor(node.data.delivery_rate, progress))}`} title={suspiciousTitle(s.deliveryRate)}>{fmtRate(node.data.delivery_rate)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${dCls(s.dailySale)}`} title={dTitle(s.dailySale)}>{dVal(node.data.daily_sale)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${dCls(s.dailyDelivery)}`} title={dTitle(s.dailyDelivery)}>{dVal(node.data.daily_delivery)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${dCls(s.remainingSale)}`} title={dTitle(s.remainingSale)}>{dVal(node.data.remaining_daily_sale_target)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${dCls(s.remainingDelivery)}`} title={dTitle(s.remainingDelivery)}>{dVal(node.data.remaining_daily_delivery_target)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.ratioTarget, "text-slate-400")}`} title={suspiciousTitle(s.ratioTarget)}>{formatRatio(targetRatio(node.data.delivery_target, node.data.sale_target))}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${suspiciousClass(s.ratioActual, absoluteThreeColor(ratioAchievement(node.data.delivery_actual, node.data.sale_actual, node.data.delivery_target, node.data.sale_target)))}`} title={suspiciousTitle(s.ratioActual)}>{formatRatio(actualRatio(node.data.delivery_actual, node.data.sale_actual))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 移动：精简 4 列（门店/区名 · 销售完成率 · 配送完成率 · 当天销售）+ 行末 ▸ 看全字段。
          树 chevron（左）展开子级，▸（右）开全字段抽屉，两个独立 tap 区。 */}
      {isMobile && (
        <div ref={tableRef} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr className="sticky top-0 z-10 bg-slate-50">
                <th className="px-2 py-2 text-left font-medium">门店</th>
                <th className="px-2 py-2 text-right font-medium">销售率</th>
                <th className="px-2 py-2 text-right font-medium">配送率</th>
                <th className="px-2 py-2 text-right font-medium">当天</th>
                <th className="w-8 px-1 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tree.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-8 text-center text-slate-400">暂无数据</td></tr>
              )}
              {flatRows.map(({ node, depth }) => {
                const hasChildren = node.children.length > 0;
                const isExpanded = expandedNodes.has(node.code);
                const indent = depth * 16;
                const s = {
                  saleRate: isSuspiciousRate(node.data.sale_rate),
                  deliveryRate: isSuspiciousRate(node.data.delivery_rate),
                  dailySale: isSuspiciousAmount(node.data.daily_sale),
                };
                return (
                  <tr key={`${node.level}-${node.data.parent_code || 'root'}-${node.code}`}>
                    <td className="px-2 py-2 text-slate-700" style={{ paddingLeft: `${indent + 8}px` }}>
                      <div className="flex items-center gap-1">
                        {hasChildren ? (
                          <button onClick={() => toggleExpand(node.code)} aria-label="展开子级" className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-slate-400">
                            {isExpanded ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
                          </button>
                        ) : null}
                        <span className={`truncate ${depth === 0 ? "font-semibold" : ""}`}>{node.name}</span>
                      </div>
                    </td>
                    <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(s.saleRate, rateColor(node.data.sale_rate, progress))}`} title={suspiciousTitle(s.saleRate)}>{fmtRate(node.data.sale_rate)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${suspiciousClass(s.deliveryRate, rateColor(node.data.delivery_rate, progress))}`} title={suspiciousTitle(s.deliveryRate)}>{fmtRate(node.data.delivery_rate)}</td>
                    <td className={`px-2 py-2 text-right tabular-nums ${dCls(s.dailySale)}`} title={dTitle(s.dailySale)}>{dVal(node.data.daily_sale)}</td>
                    <td className="px-1 py-2 text-right">
                      <button onClick={() => setDetailNode(node)} aria-label="查看全部字段" className="inline-flex h-8 w-8 items-center justify-center text-slate-400 hover:text-slate-700">
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
        fields={detailNode ? buildRegionFields(detailNode.data) : []}
        onClose={() => setDetailNode(null)}
      />
    </div>
  );
}
