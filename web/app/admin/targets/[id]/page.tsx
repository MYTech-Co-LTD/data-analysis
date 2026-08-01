// web/app/admin/targets/[id]/page.tsx
// 分解页：一个目标两板块——总部品类分解(水果/标品/耗材 × 总仓出库) + 门店分解(战区→区域→门店 × 门店销售/门店配送)
// 交互：sticky工具条(全局校验chips+搜索+统一保存) / 战区默认全折叠逐级下钻 / 表头吸顶 / 搜索定位高亮 / 未填标记
'use client';
import { useState, useEffect, useRef, Fragment } from 'react';
import { ArrowLeft, Download, Upload, ChevronDown, ChevronRight, Search, Save, Loader2, MapPin } from 'lucide-react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { targetRatio, formatRatio } from '@/lib/report-center/ratio';
import { diffImport, rowKey, type DiffEntry, type TargetMetricRow } from '@/lib/report-center/import-diff';
import { ImportDiffModal } from '@/components/report-center/import-diff-modal';

const HQ_METRICS = ['outbound_amt', 'outbound_profit'];
const HQ_CATEGORIES = ['水果', '标品', '耗材'];
const STORE_METRICS = ['sale', 'delivery'];
const METRIC_NAME: Record<string, string> = { sale: '门店销售', delivery: '门店配送', outbound_amt: '总仓出库金额', outbound_profit: '总仓出库毛利' };

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [hqGrid, setHqGrid] = useState<Record<string, Record<string, string>>>({});
  const [warZoneRows, setWarZoneRows] = useState<any[]>([]);
  const [regionRows, setRegionRows] = useState<any[]>([]);
  const [branchRows, setBranchRows] = useState<any[]>([]);
  const [balance, setBalance] = useState<any>({});
  // 折叠 / 搜索 / 保存
  const [collapsedWz, setCollapsedWz] = useState<Set<string>>(new Set());
  const [collapsedR2, setCollapsedR2] = useState<Set<string>>(new Set());
  const [kw, setKw] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<DiffEntry[] | null>(null);
  const [pendingRows, setPendingRows] = useState<TargetMetricRow[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);

  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setBalance(j.balance || {});
    const savedCat: Record<string, any> = Object.fromEntries((j.categoryRows || []).map((x: any) => [x.category, x.metrics]));
    setHqGrid(Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m, savedCat[c]?.[m] ?? '']))])));
    const br = (j.branchRows || []) as any[];
    const wzDbMap = Object.fromEntries((j.warZoneRows || []).map((r: any) => [r.war_zone, r]));
    const r2DbMap = Object.fromEntries((j.regionRows || []).map((r: any) => [`${r.war_zone}|${r.region_l2}`, r]));
    const wzs = [...new Set(br.map((b: any) => b.war_zone).filter(Boolean))];
    const r2Keys = [...new Set(br.map((b: any) => `${b.war_zone}|${b.region_l2}`))];
    const wzRows = wzs.map((wz: string) => wzDbMap[wz] || { war_zone: wz, metrics: {} });
    const rgRows = r2Keys.map((key: string) => {
      const [war_zone, region_l2] = key.split('|');
      return r2DbMap[key] || { war_zone, region_l2, metrics: {} };
    });
    wzRows.sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || ''));
    rgRows.sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || '') || (a.region_l2 || '').localeCompare(b.region_l2 || ''));
    setWarZoneRows(wzRows);
    setRegionRows(rgRows);
    setBranchRows(br);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { // 首次加载后默认全折叠战区
    if (!initRef.current && warZoneRows.length) {
      setCollapsedWz(new Set(warZoneRows.map(w => w.war_zone)));
      initRef.current = true;
    }
  }, [warZoneRows]);

  // 品类
  const setHq = (cat: string, m: string, v: string) => setHqGrid(g => ({ ...g, [cat]: { ...g[cat], [m]: v } }));
  const hqSum = (m: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(hqGrid[c]?.[m]) || 0), 0);
  // 门店三级
  const setWzCell = (wz: string, m: string, v: string) => setWarZoneRows(rs => rs.map(r => r.war_zone === wz ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const setR2Cell = (wz: string, r2: string, m: string, v: string) => setRegionRows(rs => rs.map(r => r.war_zone === wz && r.region_l2 === r2 ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  // 门店行主键：使用 @/lib/report-center/import-diff 的 rowKey —— 与 diffImport / confirmImport 共享同一份规则
  // （branch_number 优先 → system_book_code-branch_num → -branch_num；显式 if/if/return 避免 `undefined-${bn}` 字面量陷阱）
  const setStoreCell = (sKey: string, m: string, v: string) =>
    setBranchRows(rs => rs.map(r => rowKey(r) === sKey ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const wzRegionSum = (wz: string, m: string) => regionRows.filter(r => r.war_zone === wz).reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  const r2StoreSum = (wz: string, r2: string, m: string) => branchRows.filter(b => b.war_zone === wz && b.region_l2 === r2).reduce((s, b) => s + (Number(b.metrics?.[m]) || 0), 0);
  const storeSum = (m: string) => branchRows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);

  const buildHqPayload = () => HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m, Number(hqGrid[c]?.[m]) || 0])) }));
  const buildThreeLevelPayload = () => [
    ...warZoneRows.filter(wz => STORE_METRICS.some(m => Number(wz.metrics?.[m]) > 0)).map(r => ({ breakdown_level: 'war_zone', war_zone: r.war_zone, branch_num: 'ALL', metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
    ...regionRows.filter(r2 => STORE_METRICS.some(m => Number(r2.metrics?.[m]) > 0)).map(r => ({ breakdown_level: 'region_l2', war_zone: r.war_zone, region_l2: r.region_l2, branch_num: 'ALL', metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
    ...branchRows.map(r => ({ breakdown_level: 'store', branch_number: r.branch_number, system_book_code: r.system_book_code, branch_num: r.branch_num, metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
  ];
  const collectDiffs = () => {
    const diffs: string[] = [];
    STORE_METRICS.forEach(m => {
      const total = Number(balance[m]?.total) || 0;
      const stSum = storeSum(m);
      if (total && total !== stSum) diffs.push(`门店${METRIC_NAME[m]}子和 ${stSum} vs 总目标 ${total}`);
      warZoneRows.forEach(wz => {
        const wzVal = Number(wz.metrics?.[m]) || 0;
        if (!wzVal) return;
        const rSum = wzRegionSum(wz.war_zone, m);
        if (wzVal !== rSum) diffs.push(`战区${wz.war_zone} ${METRIC_NAME[m]} 区域和${rSum} vs 战区目标${wzVal}`);
      });
      regionRows.forEach(r2 => {
        const r2Val = Number(r2.metrics?.[m]) || 0;
        if (!r2Val) return;
        const sSum = r2StoreSum(r2.war_zone, r2.region_l2, m);
        if (r2Val !== sSum) diffs.push(`区域${r2.region_l2} ${METRIC_NAME[m]} 门店和${sSum} vs 区域目标${r2Val}`);
      });
    });
    HQ_METRICS.forEach(m => {
      const total = Number(balance[m]?.total) || 0;
      const sum = hqSum(m);
      if (total && total !== sum) diffs.push(`总部${METRIC_NAME[m]} 品类和${sum} vs 总目标 ${total}`);
    });
    return diffs;
  };
  // 类别分解校验：总出库目标 ≥ 门店配送汇总（否则暗示配送目标分配不合理）
  function validateHqBreakdown() {
    const deliverySum = branchRows.reduce((s, r) => s + (Number(r.metrics?.delivery) || 0), 0);
    const outboundTotal = hqSum('outbound_amt');
    if (outboundTotal < deliverySum) {
      return { valid: false, message: `总出库目标 ${outboundTotal.toLocaleString()} 小于门店配送汇总 ${deliverySum.toLocaleString()}` };
    }
    return { valid: true };
  }
  const saveAll = async () => {
    const diffs = collectDiffs();
    if (diffs.length && !confirm(`有 ${diffs.length} 处子和校验差额：\n${diffs.slice(0, 6).join('\n')}${diffs.length > 6 ? '\n...' : ''}\n确认保存？`)) return;

    // 类别分解校验：总出库目标 ≥ 门店配送汇总
    const hqValidation = validateHqBreakdown();
    if (!hqValidation.valid && !confirm(`⚠️ 类别分解警告：\n${hqValidation.message}\n\n这可能意味着配送目标分配不合理。\n确认继续保存？`)) return;

    setSaving(true);
    try {
      const r1 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), rows: buildHqPayload() }) });
      const j1 = await r1.json();
      if (!j1.ok) throw new Error(JSON.stringify(j1));
      const r2 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: 'ALL', rows: buildThreeLevelPayload() }) });
      const j2 = await r2.json();
      if (!j2.ok) throw new Error(JSON.stringify(j2));
      toast.success('已保存全部分解');
      await load();
    } catch (e: any) {
      toast.error('保存失败：' + (e?.message || String(e)));
    } finally {
      setSaving(false);
    }
  };

  const toggleWz = (wz: string) => setCollapsedWz(s => { const n = new Set(s); n.has(wz) ? n.delete(wz) : n.add(wz); return n; });
  const toggleR2 = (key: string) => setCollapsedR2(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch('/api/admin/targets/template', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.rows) {
        const incoming: TargetMetricRow[] = j.rows.map((x: any) => ({ branch_number: x.branch_number, system_book_code: x.system_book_code, branch_num: x.branch_num, branch_name: x.branch_name, metrics: x.metrics }));
        const cur: TargetMetricRow[] = branchRows.map(b => ({ branch_number: b.branch_number, system_book_code: b.system_book_code, branch_num: b.branch_num, branch_name: b.branch_name, metrics: b.metrics }));
        const diffs = diffImport(cur, incoming);
        if (diffs.length === 0) { toast.info('导入文件无变更'); e.target.value = ''; return; }
        setPendingRows(incoming);
        setPendingDiff(diffs);
      } else { toast.error('解析失败：' + (j.error || JSON.stringify(j))); }
    } catch (err) { toast.error('解析失败：' + String(err)); }
    e.target.value = '';
  };
  const confirmImport = () => {
    if (!pendingRows) return;
    const byKey = Object.fromEntries(pendingRows.map(x => [rowKey(x), x.metrics]));
    setBranchRows(rs => rs.map(rw => { const k = rowKey(rw); return byKey[k] ? { ...rw, metrics: { ...rw.metrics, ...byKey[k] } } : rw; }));
    // 新增门店（当前没有的）追加
    const existing = new Set(branchRows.map(r => rowKey(r)));
    const added = pendingRows.filter(r => !existing.has(rowKey(r)))
      .map(r => ({ system_book_code: r.system_book_code, branch_number: r.branch_number, branch_num: r.branch_num, branch_name: r.branch_name || '', war_zone: '', region_l2: '', metrics: r.metrics }));
    if (added.length) setBranchRows(rs => [...rs, ...added] as any);
    setPendingDiff(null); setPendingRows(null);
    toast.success('已应用导入变更，请点「保存全部分解」落库');
  };

  const unfilledCount = branchRows.filter(b => STORE_METRICS.every(m => !b.metrics?.[m])).length;
  const matchKw = (b: any) => !!kw && ((b.branch_num || '').includes(kw) || (b.branch_name || '').includes(kw));

  return (
    <div className="p-4">
      {/* sticky 工具条：全局校验 + 搜索 + 统一保存 */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b py-3 mb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
          <h1 className="text-xl font-bold">目标分解</h1>
          <SumChip label="销售" sum={storeSum('sale')} total={Number(balance.sale?.total) || 0} />
          <SumChip label="配送" sum={storeSum('delivery')} total={Number(balance.delivery?.total) || 0} />
          <SumChip label="总仓出库金额" sum={hqSum('outbound_amt')} total={Number(balance.outbound_amt?.total) || 0} />
          <SumChip label="总仓出库毛利" sum={hqSum('outbound_profit')} total={Number(balance.outbound_profit?.total) || 0} />
          <SumChip label="配销比" sum={storeSum('delivery')} total={storeSum('sale')} ratio />
          <span className="text-xs text-slate-500">未填门店 {unfilledCount} 家</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href="/admin/targets" className="text-primary text-sm inline-flex items-center gap-1 hover:underline"><ArrowLeft size={14} /> 返回</a>
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={kw} onChange={e => setKw(e.target.value)} placeholder="搜门店号/名" className="border rounded-md pl-7 pr-2 py-1 text-sm w-48" />
          </div>
          <div className="flex-1" />
          <a href={`/api/admin/targets/template?parent_id=${id}`} download className="inline-flex items-center gap-1.5 border border-primary text-primary px-3 py-1 text-sm rounded-md hover:bg-primary/5"><Download size={14} /> 模板</a>
          <input type="file" accept=".xlsx,.xls" ref={fileInputRef} onChange={handleImport} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="从 Excel 导入（模板含门店键 branch_number，支持共享门店号）"
            className="inline-flex items-center gap-1.5 border border-primary text-primary px-3 py-1 text-sm rounded-md hover:bg-primary/5"
          >
            <Upload size={14} /> 导入
          </button>
          <button onClick={saveAll} disabled={saving} className="bg-primary text-white px-4 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90 disabled:opacity-60 disabled:pointer-events-none">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存全部分解
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 mb-6 max-w-2xl">
        <h2 className="font-bold mb-2">总部板块·品类分解 <span className="text-xs text-slate-500 font-normal">（总仓出库金额/毛利，不拆门店）</span></h2>
        <table className="text-sm border-collapse tabular-nums w-full">
          <thead><tr className="bg-slate-50">
            <th className="border border-slate-200 p-2 text-left">品类</th>
            {HQ_METRICS.map(m => <th key={m} className="border border-slate-200 p-2 text-left">{METRIC_NAME[m]}(元)</th>)}
          </tr></thead>
          <tbody>
            {HQ_CATEGORIES.map(cat => (
              <tr key={cat}>
                <td className="border border-slate-200 p-2">{cat}</td>
                {HQ_METRICS.map(m => <td key={m} className="border border-slate-200 p-2"><input type="number" value={hqGrid[cat]?.[m] ?? ''} onChange={e => setHq(cat, m, e.target.value)} className="border rounded-md px-2 py-1 w-full text-sm text-right tabular-nums" /></td>)}
              </tr>
            ))}
            <tr className="bg-slate-50/60 font-medium">
              <td className="border border-slate-200 p-2">合计</td>
              {HQ_METRICS.map(m => {
                const sum = hqSum(m); const total = Number(balance[m]?.total || 0); const diff = sum - total;
                return <td key={m} className={`border border-slate-200 p-2 text-right tabular-nums ${diff === 0 ? 'text-green-600' : 'text-red-600'}`}>{sum.toLocaleString()}{diff !== 0 && <span className="text-xs ml-1">({diff > 0 ? '+' : ''}{diff.toLocaleString()})</span>}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-bold mb-2">门店板块·三级分解 <span className="text-xs text-slate-500 font-normal">（战区→区域→门店，门店销售/门店配送；点战区/区域展开）</span></h2>
        <div className="overflow-auto max-h-[70vh] border border-slate-200 rounded-md">
          <table className="text-sm border-collapse tabular-nums w-full min-w-[760px]">
            <thead className="sticky top-0 z-10 shadow-sm">
              <tr className="bg-slate-50">
                <th className="border border-slate-200 p-2 text-left w-40">战区</th>
                <th className="border border-slate-200 p-2 text-left w-32">区域</th>
                <th className="border border-slate-200 p-2 text-left">门店</th>
                {STORE_METRICS.map(m => <th key={m} className="border border-slate-200 p-2 text-right w-60">{METRIC_NAME[m]}（目标/子和）</th>)}
                <th className="border border-slate-200 p-2 text-right w-28">配销比</th>
              </tr>
            </thead>
          <tbody>
            {warZoneRows.map(wz => {
              const wzRegions = regionRows.filter(r => r.war_zone === wz.war_zone);
              const wzStores = branchRows.filter(b => b.war_zone === wz.war_zone);
              const wzRegionSumAll = (m: string) => wzRegions.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
              const wzFilled = wzStores.filter(b => STORE_METRICS.some(m => b.metrics?.[m])).length;
              const wzHit = wzStores.some(matchKw);
              const wzOpen = !collapsedWz.has(wz.war_zone) || wzHit;
              return (
                <Fragment key={wz.war_zone}>
                  {/* 战区行(可点击折叠) */}
                  <tr className="bg-primary/10 font-medium">
                    <td className="border border-slate-200 p-2 cursor-pointer select-none" onClick={() => toggleWz(wz.war_zone)}>
                      <span className="inline-flex items-center gap-1">
                        {wzOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <MapPin size={13} className="text-primary" />
                        {wz.war_zone}
                        <span className="ml-1 text-xs text-slate-500 font-normal">{wzFilled}/{wzStores.length} 店</span>
                      </span>
                    </td>
                    <td className="border border-slate-200 p-2"></td>
                    <td className="border border-slate-200 p-2"></td>
                    {STORE_METRICS.map(m => {
                      const sum = wzRegionSumAll(m); const target = Number(wz.metrics?.[m]) || 0; const diff = sum - target;
                      return <td key={m} className="border border-slate-200 p-2"><div className="flex items-center gap-2"><input type="number" value={wz.metrics?.[m] ?? ''} onChange={e => setWzCell(wz.war_zone, m, e.target.value)} onClick={e => e.stopPropagation()} className="border rounded-md px-2 py-1 w-32 text-sm text-right tabular-nums" /><span className={`text-xs tabular-nums ${diff === 0 ? 'text-green-600' : 'text-red-600'}`}>子和 {sum.toLocaleString()}{diff !== 0 && `(${diff > 0 ? '+' : ''}${diff})`}</span></div></td>;
                    })}
                    <td className="border border-slate-200 p-2 text-right tabular-nums text-slate-500 text-xs">
                      {formatRatio(targetRatio(wzRegionSum(wz.war_zone, 'delivery'), wzRegionSum(wz.war_zone, 'sale')))}
                    </td>
                  </tr>
                  {wzOpen && wzRegions.map(r2 => {
                    const r2Stores = branchRows.filter(b => b.war_zone === wz.war_zone && b.region_l2 === r2.region_l2);
                    const r2StoreSumL = (m: string) => r2Stores.reduce((s, b) => s + (Number(b.metrics?.[m]) || 0), 0);
                    const r2Key = `${wz.war_zone}|${r2.region_l2}`;
                    const r2Hit = r2Stores.some(matchKw);
                    const r2Open = !collapsedR2.has(r2Key) || r2Hit;
                    return (
                      <Fragment key={r2Key}>
                        {/* 区域行(可点击折叠) */}
                        <tr className="bg-slate-50 font-medium">
                          <td className="border border-slate-200 p-2"></td>
                          <td className="border border-slate-200 p-2 cursor-pointer select-none" onClick={() => toggleR2(r2Key)}>
                            <span className="inline-flex items-center gap-1">
                              {r2Open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              {r2.region_l2 || '-'}
                            </span>
                          </td>
                          <td className="border border-slate-200 p-2"></td>
                          {STORE_METRICS.map(m => {
                            const sum = r2StoreSumL(m); const target = Number(r2.metrics?.[m]) || 0; const diff = sum - target;
                            return <td key={m} className="border border-slate-200 p-2"><div className="flex items-center gap-2"><input type="number" value={r2.metrics?.[m] ?? ''} onChange={e => setR2Cell(wz.war_zone, r2.region_l2, m, e.target.value)} onClick={e => e.stopPropagation()} className="border rounded-md px-2 py-1 w-32 text-sm text-right tabular-nums" /><span className={`text-xs tabular-nums ${diff === 0 ? 'text-green-600' : 'text-red-600'}`}>子和 {sum.toLocaleString()}{diff !== 0 && `(${diff > 0 ? '+' : ''}${diff})`}</span></div></td>;
                          })}
                          <td className="border border-slate-200 p-2 text-right tabular-nums text-slate-500 text-xs">
                            {formatRatio(targetRatio(r2StoreSum(wz.war_zone, r2.region_l2, 'delivery'), r2StoreSum(wz.war_zone, r2.region_l2, 'sale')))}
                          </td>
                        </tr>
                        {r2Open && r2Stores.map(store => {
                          const unfilled = STORE_METRICS.every(m => !store.metrics?.[m]);
                          const hit = matchKw(store);
                          const sKey = rowKey(store);
                          return (
                            <tr key={sKey} className={`hover:bg-slate-50 ${unfilled ? 'bg-slate-50/60' : ''} ${hit ? 'bg-amber-50' : ''}`}>
                              <td className="border border-slate-200 p-2"></td>
                              <td className="border border-slate-200 p-2"></td>
                              <td className={`border border-slate-200 p-2 ${hit ? 'ring-1 ring-inset ring-amber-300' : ''}`}>
                                <span className="text-xs text-slate-400 mr-1 tabular-nums">{store.brand_name ? `[${store.brand_name}]` : (store.system_book_code ? `[${store.system_book_code}]` : '')}</span>
                                <span className="text-xs text-slate-400 mr-2 tabular-nums">{store.branch_num}</span>{store.branch_name}{unfilled && <span className="ml-2 text-xs text-slate-400">未填</span>}
                              </td>
                              {STORE_METRICS.map(m => <td key={m} className="border border-slate-200 p-2"><input type="number" value={store.metrics?.[m] ?? ''} onChange={e => setStoreCell(sKey, m, e.target.value)} className="border rounded-md px-2 py-1 w-32 text-sm text-right tabular-nums" /></td>)}
                              <td className="border border-slate-200 p-2 text-right tabular-nums text-slate-500 text-xs">
                                {formatRatio(targetRatio(Number(store.metrics?.delivery) || 0, Number(store.metrics?.sale) || 0))}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
      {pendingDiff && (
        <ImportDiffModal diffs={pendingDiff} onClose={() => { setPendingDiff(null); setPendingRows(null); }} onConfirm={confirmImport} />
      )}
    </div>
  );
}

// 全局校验 chip：子和 vs 总目标，差额色标（无总目标时不校验）；ratio 模式直接显示 sum/total 百分比
function SumChip({ label, sum, total, ratio }: { label: string; sum: number; total: number; ratio?: boolean }) {
  if (ratio) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600 tabular-nums">
        {label} <b>{formatRatio(total ? sum / total : null)}</b>
      </span>
    );
  }
  const diff = sum - total;
  const ok = total === 0 ? true : diff === 0;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border tabular-nums ${ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
      {label} <b>{sum.toLocaleString()}</b>{total > 0 && <span className="opacity-70">/ {total.toLocaleString()}</span>}
      {total > 0 && diff !== 0 && <span className="opacity-80">({diff > 0 ? '+' : ''}{diff.toLocaleString()})</span>}
    </span>
  );
}
