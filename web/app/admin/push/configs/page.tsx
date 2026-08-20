// web/app/admin/push/configs/page.tsx
// 推送任务管理（spec §4.2）：频率控件（业务不见 cron 表达式）+ 收件人 + 目标模式（默认自动跟随）+ 模板引用 + 启停。
// 身份来源：admin 会话（requireAdmin 验签 cookie wecom_userid + push:configure）——页面不发送任何 userId，
//   请求体只带业务数据；启停 PATCH 只发 { enabled }（防冒充，Task 7/9 决策）。
'use client';
import { useState, useEffect, useCallback } from 'react';
import { nextRunLabel, type CronSpec } from '@/lib/jobs/scheduled-reports/cron-match';

interface ConfigRow {
  config_id: string;
  name: string;
  cron_spec?: CronSpec;
  enabled: boolean;
  selector_json: { kind: 'dept' | 'person'; ids?: string[] };
  target_mode: 'follow' | 'fixed';
  target_id: number | null;
  preset_id: string;
  owner_wecom_id: string;
  last_run_date: string | null;
  last_run_txn_id: string | null;
}
interface TargetOption {
  target_id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export default function PushConfigsPage() {
  const [list, setList] = useState<ConfigRow[]>([]);
  const [presets, setPresets] = useState<Array<{ preset_id: string; name: string | null }>>([]);
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [editing, setEditing] = useState<Partial<ConfigRow> | null>(null);
  // msg：{ text, ok }——ok=true 成功（text-primary）/ ok=false 失败（text-red-600，DESIGN.md 语义色）
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const okMsg = (text: string) => setMsg({ text, ok: true });
  const errMsg = (text: string) => setMsg({ text, ok: false });

  // 目标下拉去重：/api/admin/targets 返回 report_achievement_v 行（target×metric，同目标 4 行），
  //   按 target_id 取首现去重（照 targets 管理页 Map<number,row> 手法）。
  const normalizeTargets = (rows: Record<string, unknown>[]): TargetOption[] => {
    const map = new Map<number, TargetOption>();
    for (const x of rows) {
      if (x.target_id === null || x.target_id === undefined) continue;
      const id = Number(x.target_id);
      if (map.has(id)) continue;
      map.set(id, {
        target_id: id,
        name: String(x.name ?? ''),
        start_date: String(x.start_date ?? ''),
        end_date: String(x.end_date ?? ''),
        status: String(x.status ?? ''),
      });
    }
    return [...map.values()];
  };

  const fetchAll = useCallback(async () => {
    const [c, p, t] = await Promise.all([
      fetch('/api/admin/push-configs', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/admin/push-presets', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/admin/targets', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    return {
      list: (c.data || []) as ConfigRow[],
      presets: (p.data || []) as Array<{ preset_id: string; name: string | null }>,
      targets: normalizeTargets((t.data || []) as Record<string, unknown>[]),
    };
  }, []);
  // 挂载加载：异步 setState（.then 回调），避免 effect 体内同步 setState（lint set-state-in-effect）
  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(({ list, presets, targets }) => {
        if (cancelled) return;
        setList(list);
        setPresets(presets);
        setTargets(targets);
      })
      .catch(() => { /* 端点失败静默，列表留空由空态文案提示 */ });
    return () => { cancelled = true; };
  }, [fetchAll]);
  // 事件处理器用（保存/启停后刷新）
  const load = useCallback(async () => {
    const { list, presets, targets } = await fetchAll();
    setList(list);
    setPresets(presets);
    setTargets(targets);
  }, [fetchAll]);

  // POST 新建/upsert：请求体只带业务字段，enabled 显式传（缺省 true），绝不带 userId
  const save = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/admin/push-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config_id: editing.config_id,
          name: editing.name,
          cron_spec: editing.cron_spec,
          selector: editing.selector_json,
          target_mode: editing.target_mode || 'follow',
          target_id: editing.target_id ?? null,
          preset_id: editing.preset_id,
          enabled: editing.enabled ?? true,
        }),
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

  // 启停 PATCH：只发 { enabled }；检查响应后刷新
  const toggle = async (c: ConfigRow) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/push-configs?config_id=${encodeURIComponent(c.config_id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      const j = await r.json();
      if (j.ok) okMsg(c.enabled ? '已停用' : '已启用');
      else errMsg(`操作失败：${j.error || ''}`);
      load();
    } catch (e) {
      errMsg(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const spec = editing?.cron_spec || { kind: 'daily' as const, time: '08:30' };
  // 切 kind 时补齐该 kind 的必需字段（weekly 补 weekday、monthly 补 day），避免保存时 400
  const setSpec = (patch: Partial<CronSpec>) => {
    const next = { ...spec, ...patch };
    if (patch.kind === 'weekly' && next.weekday == null) next.weekday = 1;
    if (patch.kind === 'monthly' && next.day == null) next.day = 1;
    setEditing((e) => ({ ...e, cron_spec: next }));
  };

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">推送任务</h1>
      <p className="text-sm text-slate-500 mb-3">配置「什么时间、推给谁、用哪个模板、看哪个目标的数据」。目标默认自动跟随当前进行中的；目标结束后任务自动暂停并提醒创建人。</p>
      {msg && <div className={`mb-2 text-sm ${msg.ok ? 'text-primary' : 'text-red-600'}`}>{msg.text}</div>}
      <button onClick={() => setEditing({ cron_spec: { kind: 'daily', time: '08:30' }, selector_json: { kind: 'person', ids: [] }, target_mode: 'follow' })} className="bg-primary text-white px-4 py-1 text-sm rounded-md mb-4">新建任务</button>

      {!editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <table className="w-full text-sm border-collapse tabular-nums">
            <thead><tr className="bg-slate-50">
              {['任务名', '频率', '收件人', '目标', '模板', '启用', '最近 txnId', '操作'].map((h) => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={8} className="border border-slate-200 p-2 text-slate-400 text-center">暂无任务</td></tr>}
              {list.map((c) => (
                <tr key={c.config_id}>
                  <td className="border border-slate-200 p-2">{c.name}</td>
                  <td className="border border-slate-200 p-2">{c.cron_spec ? nextRunLabel(c.cron_spec, new Date()) : '—'}</td>
                  <td className="border border-slate-200 p-2">{c.selector_json?.kind === 'dept' ? `部门×${c.selector_json.ids?.length ?? 0}` : `人员×${c.selector_json?.ids?.length ?? 0}`}</td>
                  <td className="border border-slate-200 p-2">{c.target_mode === 'follow' ? '自动跟随' : `目标 #${c.target_id}`}</td>
                  <td className="border border-slate-200 p-2">{presets.find((p) => p.preset_id === c.preset_id)?.name || c.preset_id}</td>
                  <td className="border border-slate-200 p-2">{c.enabled ? '✓' : '—'}</td>
                  <td className="border border-slate-200 p-2 text-xs text-slate-400" title={c.last_run_date ? `最近运行 ${c.last_run_date}` : undefined}>{c.last_run_txn_id?.slice(0, 8) || '—'}</td>
                  <td className="border border-slate-200 p-2 space-x-2">
                    <button className="text-primary underline" onClick={() => setEditing(c)}>编辑</button>
                    <button className="text-slate-500 underline" onClick={() => toggle(c)}>{c.enabled ? '停用' : '启用'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 max-w-2xl space-y-3">
          <div>
            <label className="text-sm text-slate-600">任务名</label>
            <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.name || ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：每日销售日报（东战区）" />
          </div>
          <div className="flex gap-2 items-end">
            <div>
              <label className="text-sm text-slate-600">频率</label>
              <select className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.kind}
                onChange={(e) => setSpec({ kind: e.target.value as CronSpec['kind'] })}>
                <option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
              </select>
            </div>
            {spec.kind === 'weekly' && (
              <select className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.weekday ?? 1} onChange={(e) => setSpec({ weekday: Number(e.target.value) })}>
                {WEEK.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}
              </select>
            )}
            {spec.kind === 'monthly' && (
              <input type="number" min={1} max={31} className="w-20 border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.day ?? 1} onChange={(e) => setSpec({ day: Number(e.target.value) })} />
            )}
            <div>
              <label className="text-sm text-slate-600">时间</label>
              <input type="time" className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.time} onChange={(e) => setSpec({ time: e.target.value })} />
            </div>
            <div className="text-xs text-slate-400 pb-1">{nextRunLabel(spec, new Date())} · 当日内错过自动补发</div>
          </div>
          <div>
            <label className="text-sm text-slate-600">收件人（人员 wecom_id，逗号分隔；部门选择器后续批次）</label>
            <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
              value={(editing.selector_json?.ids || []).join(',')}
              onChange={(e) => setEditing({ ...editing, selector_json: { kind: 'person', ids: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
              placeholder="ZhangDuo, WangSong" />
          </div>
          <div className="flex gap-4 items-center">
            <label className="text-sm text-slate-600 flex items-center gap-1">
              <input type="radio" checked={(editing.target_mode || 'follow') === 'follow'} onChange={() => setEditing({ ...editing, target_mode: 'follow' })} />
              自动跟随当前进行中的目标
            </label>
            <label className="text-sm text-slate-600 flex items-center gap-1">
              <input type="radio" checked={editing.target_mode === 'fixed'} onChange={() => setEditing({ ...editing, target_mode: 'fixed' })} />
              指定目标
            </label>
          </div>
          {editing.target_mode === 'fixed' && (
            <select className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.target_id ?? ''}
              onChange={(e) => setEditing({ ...editing, target_id: Number(e.target.value) })}>
              <option value="">选择目标…</option>
              {targets.map((t) => <option key={t.target_id} value={t.target_id}>{t.name}（{t.start_date}~{t.end_date}，{t.status}）</option>)}
            </select>
          )}
          <div>
            <label className="text-sm text-slate-600">消息模板</label>
            <select className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.preset_id || ''}
              onChange={(e) => setEditing({ ...editing, preset_id: e.target.value })}>
              <option value="">选择模板…</option>
              {presets.map((p) => <option key={p.preset_id} value={p.preset_id}>{p.name || p.preset_id}</option>)}
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={save} disabled={busy} className="bg-primary text-white px-4 py-1 text-sm rounded-md disabled:opacity-50">保存</button>
            <button onClick={() => setEditing(null)} className="px-4 py-1 text-sm text-slate-500">取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
