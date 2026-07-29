"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { ratioAchievement, targetRatio, formatRatio } from "@/lib/report-center/ratio";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";

interface RegionDrillTableProps {
  rows: RegionBreakdownRow[];
  targetMonth: number;
  progress: number; // 时间进度，如 0.677
}

// 达成率三色编码
function rateColor(rate: number | null, progress: number): string {
  if (rate == null) return "text-slate-300";
  if (rate < progress) return "text-red-600";
  return rate >= 1 ? "text-green-600" : rate >= 0.8 ? "text-amber-600" : "text-red-600";
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

export function RegionDrillTable({ rows, targetMonth, progress }: RegionDrillTableProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

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
    const body = flatRowsData.map((r) => [r.region_name, r.sub_region_name ?? "", r.branch_name ?? "", r.sale_target, r.sale_actual, fmtRate(r.sale_rate), r.delivery_target, r.delivery_actual, fmtRate(r.delivery_rate), r.daily_sale, r.daily_delivery, r.remaining_daily_sale_target, r.remaining_daily_delivery_target, formatRatio(targetRatio(r.delivery_target, r.sale_target)), formatRatio(ratioAchievement(r.delivery_actual, r.sale_actual, r.delivery_target, r.sale_target))]);
    exportExcel([head, ...body], `${targetMonth}月门店零售配送数据报表`);
  };

  const handleImage = () => { if (tableRef.current) exportImage(tableRef.current, `${targetMonth}月门店零售配送报表`); };
  const handleShare = async () => {
    try { await navigator.clipboard.writeText(window.location.href); const { toast } = await import('sonner'); toast.success('链接已复制'); } catch { /* 剪贴板拒绝时静默 */ }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">{targetMonth}月门店零售/配送数据报表</h3>
        <ChartActions onExcel={handleExcel} onImage={handleImage} onShare={handleShare} />
      </div>
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
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
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.sale_target)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.sale_actual)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.sale_rate, progress)}`}>{fmtRate(node.data.sale_rate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.delivery_target)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.delivery_actual)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.delivery_rate, progress)}`}>{fmtRate(node.data.delivery_rate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.daily_sale)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.daily_delivery)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.remaining_daily_sale_target)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtCurrency(node.data.remaining_daily_delivery_target)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400">{formatRatio(targetRatio(node.data.delivery_target, node.data.sale_target))}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{formatRatio(ratioAchievement(node.data.delivery_actual, node.data.sale_actual, node.data.delivery_target, node.data.sale_target))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
