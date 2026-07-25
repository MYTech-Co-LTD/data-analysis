// web/app/admin/items/page.tsx
// 商品档案维护：品牌切换 + 筛选(品类/分组/搜索) + 分页 + 勾选批量设分组/备注 + 单行 Modal 编辑 ext
// base 列只读(采集维护)；ext(custom_group/note) 人工维护。不暴露成本价。
'use client';
import { useState, useEffect, useRef } from 'react';

const PAGE_SIZE = 20;
const key = (sbc: string, item_num: string) => `${sbc}-${item_num}`;

export default function ItemsPage() {
  const [sbc, setSbc] = useState('3120');
  const [brands, setBrands] = useState<{ system_book_code: string; brand_name: string }[]>([
    { system_book_code: '3120', brand_name: '熊喵鲜生' },
    { system_book_code: '64188', brand_name: '品品甜' },
  ]);
  useEffect(() => { fetch('/api/admin/brands').then(r => r.json()).then(j => j.data && setBrands(j.data)); }, []);
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">商品档案维护</h1>
      <p className="text-sm text-gray-500 mb-4">base 列由采集自动维护（只读），人工只维护「分组/备注(ext)」。勾选多行可批量设分组或备注。</p>
      <div className="flex gap-2 border-b mb-4">
        <span className="px-4 py-2 text-sm bg-primary text-white rounded-t">商品列表</span>
        <select value={sbc} onChange={e => setSbc(e.target.value)} className="ml-auto border px-2 text-sm rounded-md self-end mb-1">
          {brands.map(b => <option key={b.system_book_code} value={b.system_book_code}>{b.system_book_code} {b.brand_name}</option>)}
        </select>
      </div>
      <ItemList sbc={sbc} />
    </div>
  );
}

function ItemList({ sbc }: { sbc: string }) {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ category_l1: '', category_l2: '', custom_group: '', q: '' });
  const [l1s, setL1s] = useState<string[]>([]);
  const [l2s, setL2s] = useState<string[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [sel, setSel] = useState<Map<string, any>>(new Map());
  const [batch, setBatch] = useState<null | { field: 'custom_group' | 'note' }>(null);
  const [busy, setBusy] = useState(false);

  const query = async (p: number) => {
    setPage(p);
    const q = new URLSearchParams({ sbc, page: String(p), page_size: String(PAGE_SIZE), ...filter } as any);
    const r = await fetch(`/api/admin/items?${q}`);
    const j = await r.json();
    setData(j.data || []); setTotal(j.total || 0);
  };

  const loadL1s = async () => {
    const r = await fetch(`/api/admin/items?distinct=category_l1&sbc=${sbc}`);
    const j = await r.json(); setL1s(j.data || []);
  };
  const loadL2s = async (l1: string) => {
    const r = await fetch(`/api/admin/items?distinct=category_l2&sbc=${sbc}&category_l1=${encodeURIComponent(l1)}`);
    const j = await r.json(); setL2s(j.data || []);
  };

  useEffect(() => { setFilter({ category_l1: '', category_l2: '', custom_group: '', q: '' }); setSel(new Map()); setL2s([]); query(1); loadL1s(); }, [sbc]);

  const toggle = (r: any) => {
    const m = new Map(sel); const k = key(r.system_book_code, r.item_num);
    m.has(k) ? m.delete(k) : m.set(k, r); setSel(m);
  };
  const toggleAll = () => {
    const m = new Map(sel);
    const allSel = data.every(r => m.has(key(r.system_book_code, r.item_num)));
    if (allSel) data.forEach(r => m.delete(key(r.system_book_code, r.item_num)));
    else data.forEach(r => m.set(key(r.system_book_code, r.item_num), r));
    setSel(m);
  };

  const saveExt = async () => {
    setBusy(true);
    await fetch('/api/admin/items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_book_code: edit.system_book_code, item_num: edit.item_num, custom_group: edit.custom_group, note: edit.note }) });
    setBusy(false); setEdit(null); query(page);
  };

  const saveBatch = async (val: string) => {
    const rows = [...sel.values()].map(r => ({
      system_book_code: r.system_book_code, item_num: r.item_num,
      custom_group: batch!.field === 'custom_group' ? val : (r.custom_group || ''),
      note: batch!.field === 'note' ? val : (r.note || ''),
    }));
    setBusy(true);
    await fetch('/api/admin/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    setBusy(false); setBatch(null); setSel(new Map()); query(page);
  };

  const allSel = data.length > 0 && data.every(r => sel.has(key(r.system_book_code, r.item_num)));

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <select value={filter.category_l1} onChange={e => { const l1 = e.target.value; setFilter({ ...filter, category_l1: l1, category_l2: '' }); setL2s([]); if (l1) loadL2s(l1); }} className="border px-2 py-1 text-sm rounded-md">
          <option value="">全部一级</option>
          {l1s.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filter.category_l2} onChange={e => setFilter({ ...filter, category_l2: e.target.value })} className="border px-2 py-1 text-sm rounded-md" disabled={!filter.category_l1}>
          <option value="">全部二级</option>
          {l2s.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input placeholder="分组(如 重点品)" value={filter.custom_group} onChange={e => setFilter({ ...filter, custom_group: e.target.value })} className="border px-2 py-1 text-sm rounded-md" />
        <input placeholder="搜索 编号/名称/条码" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} className="border px-2 py-1 text-sm rounded-md flex-1 min-w-[180px]" />
        <button onClick={() => query(1)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">查询</button>
      </div>

      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-gray-100">
          <th className="border p-2 w-8"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
          {['编号', '商品名称', '一级品类', '二级品类', '三级品类', '品牌', '分组(ext)', '备注(ext)', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}
        </tr></thead>
        <tbody>
          {data.map((r: any) => {
            const k = key(r.system_book_code, r.item_num);
            return (
              <tr key={k}>
                <td className="border p-2 text-center"><input type="checkbox" checked={sel.has(k)} onChange={() => toggle(r)} /></td>
                <td className="border p-2">{r.item_num}</td>
                <td className="border p-2">{r.item_name}</td>
                <td className="border p-2">{r.category_l1 || '-'}</td>
                <td className="border p-2">{r.category_l2 || '-'}</td>
                <td className="border p-2">{r.category_l3 || '-'}</td>
                <td className="border p-2">{r.item_brand || '-'}</td>
                <td className="border p-2">{r.custom_group || '-'}</td>
                <td className="border p-2">{r.note || '-'}</td>
                <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-primary">编辑ext</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-4 text-sm text-gray-600">共 {total} 条 ·
        <button disabled={page <= 1} onClick={() => query(page - 1)} className="px-2">上一页</button>
        第 {page} 页
        <button disabled={page * PAGE_SIZE >= total} onClick={() => query(page + 1)} className="px-2">下一页</button>
      </div>

      {sel.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg flex items-center gap-3 px-6 py-3">
          <span className="text-sm font-medium">已选 {sel.size} 项</span>
          <button onClick={() => setBatch({ field: 'custom_group' })} className="bg-primary text-white px-3 py-1 text-sm rounded-md">设分组…</button>
          <button onClick={() => setBatch({ field: 'note' })} className="bg-primary text-white px-3 py-1 text-sm rounded-md">设备注…</button>
          <button onClick={() => setSel(new Map())} className="text-sm text-gray-600 px-3 py-1">清除</button>
        </div>
      )}

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded-lg shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">编辑 ext：{edit.item_name}</h3>
            <label className="text-sm">自定义分组<input value={edit.custom_group || ''} onChange={e => setEdit({ ...edit, custom_group: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded-md" /></label>
            <label className="text-sm">备注<input value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} className="border w-full px-2 py-1 mb-4 rounded-md" /></label>
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-4 py-1 text-sm">取消</button><button disabled={busy} onClick={saveExt} className="bg-primary text-white px-4 py-1 text-sm rounded-md">保存</button></div>
          </div>
        </div>
      )}

      {batch && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setBatch(null)}>
          <div className="bg-white p-4 rounded-lg shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">{batch.field === 'custom_group' ? '设分组' : '设备注'}（{sel.size} 项）</h3>
            <BatchInput onSave={saveBatch} onCancel={() => setBatch(null)} busy={busy} />
          </div>
        </div>
      )}
    </div>
  );
}

function BatchInput({ onSave, onCancel, busy }: { onSave: (v: string) => void; onCancel: () => void; busy: boolean }) {
  const [v, setV] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <>
      <input ref={ref} value={v} onChange={e => setV(e.target.value)} className="border w-full px-2 py-1 mb-4 rounded-md" />
      <div className="flex gap-2 justify-end"><button onClick={onCancel} className="px-4 py-1 text-sm">取消</button><button disabled={busy} onClick={() => onSave(v)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">应用</button></div>
    </>
  );
}
