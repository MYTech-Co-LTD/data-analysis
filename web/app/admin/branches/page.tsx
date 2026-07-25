// web/app/admin/branches/page.tsx
// 门店维护：2 tab（门店列表 战区/二级只读+ext编辑 / 无战区预警）
// 战区 = dim_branch.first_level_region（采集来，跨品牌重合：东部/中部/南部/西部战区），不需人工维护
'use client';
import { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';

export default function BranchesPage() {
  const [tab, setTab] = useState<'list' | 'unmapped'>('list');
  const [sbc, setSbc] = useState('3120');
  const [brands, setBrands] = useState<{ system_book_code: string; brand_name: string }[]>([
    { system_book_code: '3120', brand_name: '熊喵鲜生' },
    { system_book_code: '64188', brand_name: '品品甜' },
  ]);
  useEffect(() => { fetch('/api/admin/brands').then(r => r.json()).then(j => j.data && setBrands(j.data)); }, []);
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">门店维护</h1>
      <p className="text-sm text-gray-500 mb-4">战区/二级区域由采集自动带入（dim_branch.first_level_region/second_level_region），跨品牌同名合并（东部战区含 3120+64188）。人工只维护「分组/备注(ext)」。</p>
      <div className="flex gap-2 border-b mb-4">
        {([['list', '门店列表'], ['unmapped', '无战区预警']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm ${tab === k ? 'bg-primary text-white rounded-t' : 'text-gray-600'}`}>{l}</button>
        ))}
        <select value={sbc} onChange={e => setSbc(e.target.value)} className="ml-auto border px-2 text-sm rounded-md self-end mb-1">
          {brands.map(b => <option key={b.system_book_code} value={b.system_book_code}>{b.system_book_code} {b.brand_name}</option>)}
        </select>
      </div>
      {tab === 'list' && <BranchList sbc={sbc} />}
      {tab === 'unmapped' && <Unmapped />}
    </div>
  );
}

function BranchList({ sbc }: { sbc: string }) {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ war_zone: '', region: '', city: '', q: '' });
  const [edit, setEdit] = useState<any>(null);
  const pageSize = 20;

  const query = async (p: number) => {
    setPage(p);
    const q = new URLSearchParams({ sbc, page: String(p), page_size: String(pageSize), ...filter } as any);
    const r = await fetch(`/api/admin/branches?${q}`);
    const j = await r.json();
    setData(j.data || []); setTotal(j.total || 0);
  };
  useEffect(() => { setFilter({ war_zone: '', region: '', city: '', q: '' }); query(1); }, [sbc]);

  const saveExt = async () => {
    await fetch('/api/admin/branches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_book_code: sbc, branch_num: edit.branch_num, custom_group: edit.custom_group, note: edit.note }) });
    setEdit(null); query(page);
  };

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        <input placeholder="战区(如 东部战区)" value={filter.war_zone} onChange={e => setFilter({ ...filter, war_zone: e.target.value })} className="border px-2 py-1 text-sm rounded-md" />
        <input placeholder="区域(二级)" value={filter.region} onChange={e => setFilter({ ...filter, region: e.target.value })} className="border px-2 py-1 text-sm rounded-md" />
        <input placeholder="城市" value={filter.city} onChange={e => setFilter({ ...filter, city: e.target.value })} className="border px-2 py-1 text-sm rounded-md" />
        <input placeholder="搜索 门店号/名称" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} className="border px-2 py-1 text-sm rounded-md flex-1 min-w-[160px]" />
        <button onClick={() => query(1)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">查询</button>
      </div>
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-gray-100">{['门店号', '名称', '战区(一级)', '二级区域', '城市', '分组(ext)', '备注(ext)', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={`${r.system_book_code}-${r.branch_num}`}>
              <td className="border p-2">{r.branch_num}</td>
              <td className="border p-2">{r.branch_name}</td>
              <td className="border p-2">{r.war_zone || <span className="text-red-600 inline-flex items-center gap-1"><AlertTriangle size={14} /> 无战区</span>}</td>
              <td className="border p-2">{r.region_l2 || '-'}</td>
              <td className="border p-2">{r.city}</td>
              <td className="border p-2">{r.custom_group || '-'}</td>
              <td className="border p-2">{r.note || '-'}</td>
              <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-primary">编辑ext</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 text-sm text-gray-600">共 {total} 条 ·
        <button disabled={page <= 1} onClick={() => query(page - 1)} className="px-2">上一页</button>
        第 {page} 页
        <button disabled={page * pageSize >= total} onClick={() => query(page + 1)} className="px-2">下一页</button>
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded-lg shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">编辑 ext：{edit.branch_name}</h3>
            <label className="text-sm">自定义分组<input value={edit.custom_group || ''} onChange={e => setEdit({ ...edit, custom_group: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded-md" /></label>
            <label className="text-sm">备注<input value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} className="border w-full px-2 py-1 mb-4 rounded-md" /></label>
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-4 py-1 text-sm">取消</button><button onClick={saveExt} className="bg-primary text-white px-4 py-1 text-sm rounded-md">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Unmapped() {
  const [data, setData] = useState<any[]>([]);
  useEffect(() => { (async () => { const r = await fetch('/api/admin/regions/unmapped'); const j = await r.json(); setData(j.data || []); })(); }, []);
  return (
    <div>
      <p className="text-sm text-gray-600 mb-2">无战区（first_level_region 空）的门店（采集源没带战区，需在乐檬后台补门店区域，或个别特殊店）：</p>
      {data.length === 0 ? <p className="text-green-600 inline-flex items-center gap-1"><CheckCircle size={14} /> 全部门店都有战区</p> : (
        <table className="w-full text-sm border-collapse">
          <thead><tr className="bg-gray-100">{['品牌', '门店号', '名称', '区域'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
          <tbody>{data.map((r: any) => <tr key={`${r.system_book_code}-${r.branch_num}`}><td className="border p-2">{r.system_book_code}</td><td className="border p-2">{r.branch_num}</td><td className="border p-2">{r.branch_name}</td><td className="border p-2">{r.region_name || '-'}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
