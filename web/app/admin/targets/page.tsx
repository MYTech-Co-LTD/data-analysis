// web/app/admin/targets/page.tsx
// 目标管理：列表展示目标，点击「新建目标」创建（仅填名称+时间）。
'use client';
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

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
                  {/* 显示层状态：active 且未到期=进行中；到期（即使未定格）=已结束 */}
                  {(() => { const ongoing = t.status === 'active' && t.end >= new Date().toISOString().slice(0, 10); return (
                  <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${ongoing ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                    {ongoing ? '进行中' : '已结束'}
                  </span> ); })()}
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

// 新建目标：仅填写名称和时间范围
function TargetForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    setBusy(true);
    const r1 = await fetch('/api/admin/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: start, end_date: end })
    });
    const j1 = await r1.json();
    setBusy(false);
    if (j1.ok) onSaved(); else setErr(j1.error || '创建失败');
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[600px] max-w-[92vw] max-h-[92vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建目标</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div><label className="text-xs text-slate-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月经营目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-slate-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-slate-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
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
