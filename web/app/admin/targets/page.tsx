// web/app/admin/targets/page.tsx
// 目标管理：一个目标含总部板块(品类×总仓出库) + 门店板块(门店销售/门店配送,分解门店)。列表按 target_id 聚合。
'use client';
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { targetRatio, formatRatio } from '@/lib/report-center/ratio';

const HQ_METRICS = [
  { code: 'outbound_amt', name: '总仓出库金额' },
  { code: 'outbound_profit', name: '总仓出库毛利' },
];
const HQ_CATEGORIES = ['水果', '标品', '耗材'];
const STORE_METRICS = [
  { code: 'sale', name: '门店销售' },
  { code: 'delivery', name: '门店配送' },
];

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const load = async () => {
    const r = await fetch('/api/admin/targets'); const j = await r.json();
    const raw = (j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null);
    const map = new Map<number, any>();
    for (const r of raw) {
      if (!map.has(r.target_id)) map.set(r.target_id, { id: r.target_id, name: r.name, sbc: r.system_book_code, start: r.start_date, end: r.end_date, status: r.status, metrics: {} });
      map.get(r.target_id)!.metrics[r.metric_code] = { value: Number(r.target_value), rate: r.achievement_rate };
    }
    setList([...map.values()]);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const fmt = (m: any) => m ? Number(m.value).toLocaleString() : '-';

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">目标管理</h1>
      <p className="text-sm text-slate-500 mb-3">每个目标含「总部板块」(总仓出库金额/毛利按品类，不拆门店) + 「门店板块」(门店销售/门店配送，分解到门店)。</p>
      <div className="mb-4"><button onClick={() => setShow(true)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">新建目标</button></div>
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <table className="w-full text-sm border-collapse tabular-nums">
          <thead><tr className="bg-slate-50">
            {['名称', '周期', '总仓出库金额', '总仓出库毛利', '门店销售', '门店配送', '状态', '操作'].map(h => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="border border-slate-200 p-2 text-slate-400 text-center">加载中…</td></tr> : list.length === 0 && <tr><td colSpan={8} className="border border-slate-200 p-2 text-slate-400 text-center">暂无目标</td></tr>}
            {list.map(t => (
              <tr key={t.id}>
                <td className="border border-slate-200 p-2">{t.name}</td>
                <td className="border border-slate-200 p-2">{t.start}~{t.end}</td>
                <td className="border border-slate-200 p-2 text-right">{fmt(t.metrics.outbound_amt)}</td>
                <td className="border border-slate-200 p-2 text-right">{fmt(t.metrics.outbound_profit)}</td>
                <td className="border border-slate-200 p-2 text-right">{fmt(t.metrics.sale)}</td>
                <td className="border border-slate-200 p-2 text-right">{fmt(t.metrics.delivery)}</td>
                <td className="border border-slate-200 p-2">
                  <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${t.status === 'active' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                    {t.status === 'active' ? '进行中' : '已结束'}
                  </span>
                </td>
                <td className="border border-slate-200 p-2"><a href={`/admin/targets/${t.id}`} className="text-primary">分解</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {show && <TargetForm onSaved={() => { setShow(false); load(); }} onClose={() => setShow(false)} />}
    </div>
  );
}

// 新建目标：一个 form 两板块——总部(品类3×2) + 门店(门店销售总/门店配送总)
function TargetForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('ALL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m.code, '']))]))
  );
  const [storeVals, setStoreVals] = useState<Record<string, string>>(Object.fromEntries(STORE_METRICS.map(m => [m.code, ''])));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setCat = (cat: string, code: string, v: string) => setGrid(g => ({ ...g, [cat]: { ...g[cat], [code]: v } }));
  const catSum = (code: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(grid[c]?.[code]) || 0), 0);

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    if (HQ_CATEGORIES.some(c => HQ_METRICS.some(m => !grid[c][m.code]))) { setErr('请填满总部板块 3 个品类目标值'); return; }
    if (STORE_METRICS.some(m => !storeVals[m.code])) { setErr('请填门店板块销售/配送总目标'); return; }
    setBusy(true);
    const totalMetrics = [
      ...HQ_METRICS.map(m => ({ metric_code: m.code, target_value: catSum(m.code) })),
      ...STORE_METRICS.map(m => ({ metric_code: m.code, target_value: Number(storeVals[m.code]) || 0 })),
    ];
    const r1 = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, system_book_code: brand, start_date: start, end_date: end, target_type: 'store', metrics: totalMetrics }) });
    const j1 = await r1.json();
    if (!j1.ok) { setBusy(false); setErr(j1.error || '建总目标失败'); return; }
    const rows = HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m.code, Number(grid[c][m.code]) || 0])) }));
    const r2 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: j1.target_id, rows }) });
    const j2 = await r2.json();
    setBusy(false);
    if (j2.ok) onSaved(); else setErr(j2.error || '品类分解失败');
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[600px] max-w-[92vw] max-h-[92vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建目标</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-4 gap-4 mb-4">
          <div className="col-span-1"><label className="text-xs text-slate-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月经营目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-slate-500">汇总范围</label><select value={brand} onChange={e => setBrand(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm bg-white"><option value="ALL">全公司(3120+64188)</option><option value="3120">仅 3120</option><option value="64188">仅 64188</option></select></div>
          <div><label className="text-xs text-slate-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-slate-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
        </div>

        <h3 className="font-medium text-sm mb-1 text-primary">总部板块 <span className="text-xs text-slate-500 font-normal">（总仓出库金额/毛利，按品类，不拆门店）</span></h3>
        <div className="rounded-lg border border-slate-200 bg-white p-4 mb-4">
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead><tr className="bg-slate-50">
              <th className="border border-slate-200 p-2 text-left font-normal">品类</th>
              {HQ_METRICS.map(m => <th key={m.code} className="border border-slate-200 p-2 text-left font-normal">{m.name}(元)</th>)}
            </tr></thead>
            <tbody>
              {HQ_CATEGORIES.map(cat => (
                <tr key={cat}>
                  <td className="border border-slate-200 p-2">{cat}</td>
                  {HQ_METRICS.map(m => <td key={m.code} className="border border-slate-200 p-2"><input type="number" value={grid[cat][m.code]} onChange={e => setCat(cat, m.code, e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></td>)}
                </tr>
              ))}
              <tr className="bg-slate-50/60 font-medium">
                <td className="border border-slate-200 p-2">合计</td>
                {HQ_METRICS.map(m => <td key={m.code} className="border border-slate-200 p-2 text-right">{catSum(m.code).toLocaleString()}</td>)}
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="font-medium text-sm mb-1 text-primary">门店板块 <span className="text-xs text-slate-500 font-normal">（门店销售/门店配送总目标，保存后在分解页拆到门店）</span></h3>
        <div className="rounded-lg border border-slate-200 bg-white p-4 mb-4">
          <div className="grid grid-cols-2 gap-4">
            {STORE_METRICS.map(m => (
              <div key={m.code}><label className="text-xs text-slate-500">{m.name}总目标(元)</label><input type="number" value={storeVals[m.code]} onChange={e => setStoreVals({ ...storeVals, [m.code]: e.target.value })} className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></div>
            ))}
            <div className="col-span-2 mt-1 text-xs text-slate-500 tabular-nums">
              配销比（自动）：{formatRatio(targetRatio(Number(storeVals.delivery) || 0, Number(storeVals.sale) || 0))}
            </div>
          </div>
        </div>

        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-slate-300 px-4 py-1 text-sm rounded-md hover:bg-slate-50">取消</button>
          <button disabled={busy} onClick={submit} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">保存目标</button>
        </div>
      </div>
    </div>
  );
}
