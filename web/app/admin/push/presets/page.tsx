// web/app/admin/push/presets/page.tsx
// 推送模板管理（spec §4.1）：列表 + 区域级表单编辑器 + 变量点选（通俗名）+ 实时预览 + 测试发自己。
// 身份来源：admin 会话（requireAdmin 验签 cookie wecom_userid）——页面不发送任何 userId，
//   CRUD / 变量 / 测试发送三组 admin 代理端点都从 cookie 读身份（防冒充，Task 7 决策）。
'use client';
import { useState, useEffect, useCallback } from 'react';
import CardPreview, { type PreviewCard } from '@/components/admin/push/CardPreview';

// 变量 UI 口径（migration 204）：只显 name（通俗中文名）+ description（口径说明），
//   var_code/metric_code 是内部实现细节，不进入任何界面——插入的 {{var_code}} 是数据不是 UI。
interface VarRow {
  var_code: string;
  name: string;
  description: string | null;
  enabled: boolean;
}
interface PresetRow {
  preset_id: string;
  name: string | null;
  msgtype: string;
  card_json: PreviewCard | null;
  enabled: boolean;
  push_configs?: Array<{ count: number }>;
}

const emptyCard = (): PreviewCard => ({
  card_type: 'news_notice',
  source: { desc: '山海数据平台', desc_color: 1 },
  main_title: { title: '数据日报', desc: '' },
  card_image: { url: 'https://data.shanhaiyiguo.com/push/daily-report-banner.png', aspect_ratio: 2.25 },
  vertical_content_list: [{ title: '销售额', value: '' }],
  card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
});

export default function PushPresetsPage() {
  const [list, setList] = useState<PresetRow[]>([]);
  const [vars, setVars] = useState<VarRow[]>([]);
  const [editing, setEditing] = useState<{ preset_id?: string; name: string; card: PreviewCard } | null>(null);
  // msg：{ text, ok }——ok=true 成功（text-primary）/ ok=false 失败（text-red-600，DESIGN.md 语义色）
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const okMsg = (text: string) => setMsg({ text, ok: true });
  const errMsg = (text: string) => setMsg({ text, ok: false });

  const fetchAll = useCallback(async () => {
    const [p, v] = await Promise.all([
      fetch('/api/admin/push-presets', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/admin/push/variables', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    return {
      list: (p.data || []) as PresetRow[],
      vars: (v.variables || []).filter((x: VarRow) => x.enabled !== false) as VarRow[],
    };
  }, []);
  // 挂载加载：异步 setState（.then 回调），避免 effect 体内同步 setState（lint set-state-in-effect）
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(({ list, vars }) => {
        if (cancelled) return;
        setList(list);
        setVars(vars);
      })
      .catch(() => { /* 端点失败静默，列表留空由空态文案提示 */ });
    return () => { cancelled = true; };
  }, [fetchAll]);
  // 事件处理器用（保存/删除后刷新）
  const load = useCallback(async () => {
    const { list, vars } = await fetchAll();
    setList(list);
    setVars(vars);
  }, [fetchAll]);

  const save = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/admin/push-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset_id: editing.preset_id, name: editing.name, card_json: editing.card }),
      });
      const j = await r.json();
      if (j.ok) { okMsg('已保存'); setEditing(null); load(); }
      else errMsg(`保存失败：${j.error || ''} ${JSON.stringify(j.detail || '')}`);
    } catch (e) {
      errMsg(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const selfTest = async () => {
    if (!editing || !editing.preset_id || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/admin/push/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId: editing.preset_id }),
      });
      const j = await r.json();
      if (j.ok) okMsg(`测试已发送到你的企微（txnId ${j.txnId}，${j.groups ?? 0} 组）`);
      else errMsg(`测试失败：${j.error || ''}`);
    } catch (e) {
      errMsg(`测试失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PresetRow) => {
    if (!confirm(`删除模板「${p.name || p.preset_id}」？`)) return;
    try {
      const r = await fetch(`/api/admin/push-presets?preset_id=${encodeURIComponent(p.preset_id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) okMsg('已删除');
      else errMsg(`删除失败：${j.error || ''}`);
      load();
    } catch (e) {
      errMsg(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 追加变量 token 到目标字段（main_title.title/desc 或第 vIdx 行 title/value）
  const insertVar = (code: string, field: 'title' | 'desc' | 'value', vIdx?: number) => {
    if (!editing) return;
    const token = `{{${code}}}`;
    setEditing((e) => {
      if (!e) return e;
      if (vIdx === undefined) {
        const mt = { ...(e.card.main_title || {}) };
        (mt as Record<string, string>)[field] = ((mt as Record<string, string>)[field] || '') + token;
        return { ...e, card: { ...e.card, main_title: mt } };
      }
      const vcl = (e.card.vertical_content_list || []).map((row, i) => {
        if (i !== vIdx) return row;
        return field === 'title'
          ? { ...row, title: (row.title || '') + token }
          : { ...row, value: (row.value || '') + token };
      });
      return { ...e, card: { ...e.card, vertical_content_list: vcl } };
    });
  };

  // 变量点选按钮（口径：只显 name + description，var_code/metric_code 不出现在任何界面）
  const varChips = (onPick: (code: string) => void) =>
    vars.length === 0 ? (
      <span className="text-xs text-slate-400">（无启用变量）</span>
    ) : (
      <div className="flex flex-wrap gap-1 mt-1">
        {vars.map((v) => (
          <button
            key={v.var_code}
            type="button"
            title={v.description || v.name}
            onClick={() => onPick(v.var_code)}
            className="px-2 py-0.5 text-xs rounded border border-slate-300 hover:border-primary hover:text-primary"
          >
            + {v.name}
          </button>
        ))}
      </div>
    );

  const setVcl = (i: number, patch: Record<string, string>) =>
    setEditing({ ...editing!, card: { ...editing!.card, vertical_content_list: (editing!.card.vertical_content_list || []).map((r2, j) => (j === i ? { ...r2, ...patch } : r2)) } });

  const removeVclRow = (i: number) =>
    setEditing({ ...editing!, card: { ...editing!.card, vertical_content_list: (editing!.card.vertical_content_list || []).filter((_, j) => j !== i) } });

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">推送模板</h1>
      <p className="text-sm text-slate-500 mb-3">企微卡片模板库：配置区域与文案，点选指标变量，右侧实时预览。保存后可在「推送任务」里引用。</p>
      {msg && <div className={`mb-2 text-sm ${msg.ok ? 'text-primary' : 'text-red-600'}`}>{msg.text}</div>}
      <button onClick={() => setEditing({ name: '', card: emptyCard() })} className="bg-primary text-white px-4 py-1 text-sm rounded-md mb-4">新建模板</button>

      {!editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead><tr className="bg-slate-50">
              {['模板名', '类型', '启用', '被任务引用', '操作'].map((h) => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={5} className="border border-slate-200 p-2 text-slate-400 text-center">暂无模板</td></tr>}
              {list.map((p) => (
                <tr key={p.preset_id}>
                  <td className="border border-slate-200 p-2">{p.name || p.preset_id}</td>
                  <td className="border border-slate-200 p-2">{p.msgtype}</td>
                  <td className="border border-slate-200 p-2">{p.enabled ? '✓' : '—'}</td>
                  <td className="border border-slate-200 p-2">{p.push_configs?.[0]?.count ?? 0}</td>
                  <td className="border border-slate-200 p-2 space-x-2">
                    <button className="text-primary underline" onClick={() => setEditing({ preset_id: p.preset_id, name: p.name || '', card: p.card_json || emptyCard() })}>编辑</button>
                    <button className="text-red-500 underline" onClick={() => remove(p)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="flex gap-6 items-start flex-wrap">
          <div className="flex-1 min-w-[320px] rounded-lg border border-slate-200 bg-white p-4 space-y-3">
            <div>
              <label className="text-sm text-slate-600">模板名</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：每日销售日报" />
            </div>
            <div>
              <label className="text-sm text-slate-600">主标题</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.main_title?.title || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, main_title: { ...editing.card.main_title, title: e.target.value } } })} />
              {varChips((c) => insertVar(c, 'title'))}
            </div>
            <div>
              <label className="text-sm text-slate-600">副标题（可插变量）</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.main_title?.desc || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, main_title: { ...editing.card.main_title, desc: e.target.value } } })} />
              {varChips((c) => insertVar(c, 'desc'))}
            </div>
            <div>
              <label className="text-sm text-slate-600">键值行（0-4 行，值可插变量）</label>
              {(editing.card.vertical_content_list || []).map((row, i) => (
                <div key={i} className="flex gap-2 mb-1">
                  <input className="w-32 border border-slate-300 rounded-md px-2 py-1 text-sm" value={row.title || ''} placeholder="名称"
                    onChange={(e) => setVcl(i, { title: e.target.value })} />
                  <input className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm" value={row.value || ''} placeholder="值（点下方变量插入）"
                    onChange={(e) => setVcl(i, { value: e.target.value })} />
                  <button className="text-red-500 text-sm" onClick={() => removeVclRow(i)}>✕</button>
                </div>
              ))}
              {varChips((c) => insertVar(c, 'value', 0))}
              {(editing.card.vertical_content_list?.length ?? 0) < 4 && (
                <button className="text-sm text-primary underline mt-1" onClick={() => setEditing({ ...editing, card: { ...editing.card, vertical_content_list: [...(editing.card.vertical_content_list || []), { title: '', value: '' }] } })}>+ 加一行</button>
              )}
            </div>
            <div>
              <label className="text-sm text-slate-600">整卡跳转链接</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.card_action?.url || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, card_action: { ...(editing.card.card_action || {}), type: 1, url: e.target.value } } })} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={busy} className="bg-primary text-white px-4 py-1 text-sm rounded-md disabled:opacity-50">保存</button>
              <button onClick={selfTest} disabled={!editing.preset_id || busy} className="border border-primary text-primary px-4 py-1 text-sm rounded-md disabled:opacity-40 disabled:cursor-not-allowed" title={editing.preset_id ? '' : '先保存再测试'}>测试发送到自己</button>
              <button onClick={() => setEditing(null)} className="px-4 py-1 text-sm text-slate-500">取消</button>
            </div>
          </div>
          <div className="w-[340px]"><CardPreview card={editing.card} /></div>
        </div>
      )}
    </div>
  );
}
