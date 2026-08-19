'use client';
// web/components/admin/scope-tree.tsx
// 2026-08-18 能力页「数据范围」版块：战区→二级区域→门店 三级树，可展开/勾选/复制。
// 复制产物 = Casdoor permission Resources「Custom」(tags 模式) 可直接粘贴的资源串（换行分隔）。
// v2 增强：全局搜门店（跨树定位）/ 区域一键勾选全部门店 / 门店行单独复制。
import { useEffect, useMemo, useState } from 'react';

interface Store { n: string; name: string; branchNumber: string; dup: boolean }
interface Region { name: string; grantable: boolean; users: number; stores: Store[] }
interface WarZone { name: string; grantable: boolean; users: number; storeCount: number; regions: Region[] }
interface TreeData { tree: WarZone[]; totalStores: number }

const resOf = (s: Store) => `范围|${s.dup ? s.branchNumber : s.name}`;

export function ScopeTree() {
  const [data, setData] = useState<TreeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [q, setQ] = useState('');

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
  const checkMany = (items: string[]) =>
    setChecked((prev) => { const n = new Set(prev); items.forEach((i) => n.add(i)); return n; });

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const copyAll = () => copyText([...checked].sort().join('\n'));

  // 搜索命中：门店名/编号包含关键词 → 自动展开其战区和区域
  const searchMode = q.trim().length > 0;
  const hits = useMemo(() => {
    if (!data || !searchMode) return new Map<string, Store[]>();
    const kw = q.trim().toLowerCase();
    const m = new Map<string, Store[]>();
    for (const wz of data.tree) for (const rg of wz.regions) {
      const matched = rg.stores.filter((s) =>
        s.name.toLowerCase().includes(kw) || s.branchNumber.toLowerCase().includes(kw));
      if (matched.length) m.set(`${wz.name}/${rg.name}`, matched);
    }
    return m;
  }, [data, q, searchMode]);

  // 搜索态的展开集在渲染期推导（不用 effect setState）：命中路径全展开
  const effectiveExpanded = searchMode
    ? (() => {
        const n = new Set(expanded);
        for (const key of hits.keys()) {
          const [wz] = key.split('/');
          n.add(wz);
          n.add(key);
        }
        return n;
      })()
    : expanded;

  if (err) return <div className="text-sm text-red-600">数据范围树加载失败：{err}</div>;
  if (!data) return <div className="text-sm text-slate-400">数据范围树加载中…</div>;

  return (
    <div>
      <p className="text-xs text-slate-400 mb-2">
        共 {data.tree.length} 战区 / {data.totalStores} 家门店。勾选（战区包/区域包/单店均可）后复制，粘贴到 Casdoor
        permission 的 Resources（资源类型「Custom」）→ 用户重登生效。⚠ 门店重名（授权自动用编号）。
      </p>

      <div className="flex items-center gap-2 mb-2">
        <input
          className="w-72 rounded border border-slate-200 px-3 py-1.5 text-sm"
          placeholder="搜门店名或编号（如 曲靖 / 3120-0066）"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        {searchMode && (
          <span className="text-xs text-slate-500">
            命中 {hits.size} 个区域 {[...hits.values()].reduce((s, xs) => s + xs.length, 0)} 家门店
            <button className="ml-2 text-slate-400 hover:text-slate-700" onClick={() => setQ('')}>清除</button>
          </span>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white max-h-[28rem] overflow-auto">
        {data.tree.map((wz) => {
          const wzRes = `范围|${wz.name}`;
          const wzRegionsVisible = effectiveExpanded.has(wz.name);
          if (searchMode && ![...hits.keys()].some((k) => k.startsWith(`${wz.name}/`))) return null;
          return (
            <div key={wz.name} className="border-b border-slate-100 last:border-0">
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 sticky top-0 z-10">
                <button className="text-slate-400 hover:text-slate-700 text-xs w-4" onClick={() => toggleExpand(wz.name)}>
                  {wzRegionsVisible ? '▾' : '▸'}
                </button>
                <label className={`flex items-center gap-1.5 text-sm text-slate-700 ${wz.grantable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                  <input type="checkbox" checked={checked.has(wzRes)} onChange={() => toggleCheck(wzRes)} disabled={!wz.grantable} />
                  {wz.name}
                </label>
                <span className="text-[11px] text-slate-400">{wz.storeCount} 店</span>
                {wz.grantable
                  ? <span className="text-[11px] text-green-600">✓ 范围包</span>
                  : <span className="text-[11px] text-red-500" title="maps_branch_group 无此包，粘贴到 Casdoor 会导致登录 503；范围包同步每日 04:23 自动补齐">✗ 不可授权（待同步）</span>}
                {wz.users > 0 && <span className="text-[11px] text-blue-500">{wz.users} 人在用</span>}
                <button className={`ml-auto text-[11px] ${wz.grantable ? 'text-slate-400 hover:text-slate-700' : 'text-slate-300 cursor-not-allowed'}`}
                  title={wz.grantable ? undefined : '不可授权：maps 无此包，待同步补齐'}
                  onClick={() => wz.grantable && copyText(wzRes)}>复制</button>
              </div>

              {wzRegionsVisible && wz.regions.map((rg) => {
                const rgRes = `范围|${rg.name}`;
                const rgKey = `${wz.name}/${rg.name}`;
                const rgStores = searchMode ? (hits.get(rgKey) ?? []) : rg.stores;
                if (searchMode && rgStores.length === 0) return null;
                const allRes = rg.stores.map(resOf);
                const allChecked = allRes.every((r) => checked.has(r));
                return (
                  <div key={rgKey} className="pl-6 border-t border-slate-50">
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <button className="text-slate-400 hover:text-slate-700 text-xs w-4" onClick={() => toggleExpand(rgKey)}>
                        {effectiveExpanded.has(rgKey) ? '▾' : '▸'}
                      </button>
                      <label className={`flex items-center gap-1.5 text-sm text-slate-600 ${rg.grantable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                        <input type="checkbox" checked={checked.has(rgRes)} onChange={() => toggleCheck(rgRes)} disabled={!rg.grantable} />
                        {rg.name || '（未分区）'}
                      </label>
                      <span className="text-[11px] text-slate-400">{rg.stores.length} 店</span>
                      {rg.grantable
                        ? <span className="text-[11px] text-green-600">✓</span>
                        : <span className="text-[11px] text-red-500" title="maps_branch_group 无此包，粘贴到 Casdoor 会导致登录 503；范围包同步每日 04:23 自动补齐">✗ 不可授权</span>}
                      {rg.users > 0 && <span className="text-[11px] text-blue-500">{rg.users} 人在用</span>}
                      <button
                        className={`text-[11px] ${allChecked ? 'text-blue-500' : 'text-slate-400'} hover:text-slate-700`}
                        title="勾选/取消本区全部门店（单店粒度）"
                        onClick={() => checkMany(allRes)}>
                        {allChecked ? '✓ 已全选门店' : '选本区门店'}
                      </button>
                      <button className={`ml-auto text-[11px] ${rg.grantable ? 'text-slate-400 hover:text-slate-700' : 'text-slate-300 cursor-not-allowed'}`}
                        title={rg.grantable ? undefined : '不可授权：maps 无此包，待同步补齐'}
                        onClick={() => rg.grantable && copyText(rgRes)}>复制</button>
                    </div>

                    {effectiveExpanded.has(rgKey) && (
                      <div className="pl-8 pb-2 grid grid-cols-2 md:grid-cols-3 gap-x-4">
                        {rgStores.map((s) => {
                          const sRes = resOf(s);
                          return (
                            <div key={s.n} className="group flex items-center gap-1.5 text-xs text-slate-500 py-0.5">
                              <input type="checkbox" checked={checked.has(sRes)} onChange={() => toggleCheck(sRes)} />
                              <span>{s.name}</span>
                              {s.dup && <span title="重名门店，授权用编号" className="text-amber-500">⚠</span>}
                              <span className="text-slate-300">{s.branchNumber}</span>
                              <button
                                className="hidden group-hover:inline text-[10px] text-slate-400 hover:text-slate-700"
                                onClick={() => copyText(sRes)}>复制</button>
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
        <span className="text-xs text-slate-500">
          已选 {checked.size} 项{checked.size > 0 && '（换行分隔，直接粘贴到 Casdoor Resources）'}
        </span>
        {checked.size > 0 && (
          <button onClick={() => setChecked(new Set())} className="text-xs text-slate-400 hover:text-slate-700">清空</button>
        )}
      </div>
    </div>
  );
}
