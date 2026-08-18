'use client';
// web/components/admin/scope-tree.tsx
// 2026-08-18 能力页「数据范围」版块：战区→二级区域→门店 三级树，可展开/勾选/复制。
// 复制产物 = Casdoor permission Resources「Custom」可直接粘贴的资源串（范围|<包名或门店名>，换行分隔）。
import { useEffect, useMemo, useState } from 'react';

interface Store { n: string; name: string; branchNumber: string; dup: boolean }
interface Region { name: string; grantable: boolean; users: number; stores: Store[] }
interface WarZone { name: string; grantable: boolean; users: number; storeCount: number; regions: Region[] }
interface TreeData { tree: WarZone[]; totalStores: number }

export function ScopeTree() {
  const [data, setData] = useState<TreeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/admin/scope-tree')
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const toggleExpand = (k: string) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(k)) { n.delete(k); } else { n.add(k); } return n; });

  const toggleCheck = (res: string) =>
    setChecked((prev) => { const n = new Set(prev); if (n.has(res)) { n.delete(res); } else { n.add(res); } return n; });

  const copyAll = async () => {
    await navigator.clipboard.writeText([...checked].sort().join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const summary = useMemo(() => {
    if (!data) return '';
    const packs = [...checked].filter((c) => !/^范围\|\d+-\d+$/.test(c) || data.tree.some((w) => `范围|${w.name}` === c)).length;
    return `已选 ${checked.size} 项（含包 ${packs}、单店 ${checked.size - packs}）`;
  }, [checked, data]);

  if (err) return <div className="text-sm text-red-600">数据范围树加载失败：{err}</div>;
  if (!data) return <div className="text-sm text-slate-400">数据范围树加载中…</div>;

  return (
    <div>
      <p className="text-xs text-slate-400 mb-2">
        共 {data.tree.length} 战区 / {data.totalStores} 家门店。勾选后复制，粘贴到 Casdoor permission 的
        Resources（资源类型选「Custom」）→ 用户重登生效。带 ✓ 的节点是范围包（maps 有定义）；⚠ 门店重名（授权须用编号）。
      </p>

      <div className="rounded-lg border border-slate-200 bg-white max-h-[28rem] overflow-auto">
        {data.tree.map((wz) => {
          const wzRes = `范围|${wz.name}`;
          return (
            <div key={wz.name} className="border-b border-slate-100 last:border-0">
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 sticky top-0">
                <button className="text-slate-400 hover:text-slate-700 text-xs w-4" onClick={() => toggleExpand(wz.name)}>
                  {expanded.has(wz.name) ? '▾' : '▸'}
                </button>
                <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={checked.has(wzRes)} onChange={() => toggleCheck(wzRes)} />
                  {wz.name}
                </label>
                <span className="text-[11px] text-slate-400">{wz.storeCount} 店</span>
                {wz.grantable
                  ? <span className="text-[11px] text-green-600">✓ 范围包</span>
                  : <span className="text-[11px] text-slate-300">无独立包（勾下级区域包）</span>}
                {wz.users > 0 && <span className="text-[11px] text-blue-500">{wz.users} 人在用</span>}
                <button className="ml-auto text-[11px] text-slate-400 hover:text-slate-700"
                  onClick={() => { navigator.clipboard.writeText(wzRes); }}>复制</button>
              </div>

              {expanded.has(wz.name) && wz.regions.map((rg) => {
                const rgRes = `范围|${rg.name}`;
                const rgKey = `${wz.name}/${rg.name}`;
                return (
                  <div key={rgKey} className="pl-6 border-t border-slate-50">
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <button className="text-slate-400 hover:text-slate-700 text-xs w-4" onClick={() => toggleExpand(rgKey)}>
                        {expanded.has(rgKey) ? '▾' : '▸'}
                      </button>
                      <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
                        <input type="checkbox" checked={checked.has(rgRes)} onChange={() => toggleCheck(rgRes)} />
                        {rg.name || '（未分区）'}
                      </label>
                      <span className="text-[11px] text-slate-400">{rg.stores.length} 店</span>
                      {rg.grantable && <span className="text-[11px] text-green-600">✓</span>}
                      {rg.users > 0 && <span className="text-[11px] text-blue-500">{rg.users} 人在用</span>}
                      <button className="ml-auto text-[11px] text-slate-400 hover:text-slate-700"
                        onClick={() => { navigator.clipboard.writeText(rgRes); }}>复制</button>
                    </div>

                    {expanded.has(rgKey) && (
                      <div className="pl-8 pb-2 grid grid-cols-2 md:grid-cols-3 gap-x-4">
                        {rg.stores.map((s) => {
                          const sRes = `范围|${s.dup ? s.branchNumber : s.name}`;
                          return (
                            <div key={s.n} className="flex items-center gap-1.5 text-xs text-slate-500 py-0.5">
                              <input type="checkbox" checked={checked.has(sRes)} onChange={() => toggleCheck(sRes)} />
                              <span>{s.name}</span>
                              {s.dup && <span title="重名门店，授权用编号" className="text-amber-500">⚠</span>}
                              <span className="text-slate-300">{s.branchNumber}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={copyAll}
          disabled={checked.size === 0}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:bg-slate-300">
          {copied ? '✅ 已复制' : `复制所选 ${checked.size} 项`}
        </button>
        <span className="text-xs text-slate-500">{summary}</span>
        {checked.size > 0 && (
          <button onClick={() => setChecked(new Set())} className="text-xs text-slate-400 hover:text-slate-700">清空</button>
        )}
      </div>
    </div>
  );
}
