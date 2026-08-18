'use client';
// web/app/admin/scope/page.tsx
// 2026-08-18 门店范围显式授权 P3：「数据范围总览」——每人授权面中文展示：
//   常规范围（范围|xx）· 品牌/品类/字段 · 企微组（仅目录对照）
//   + 体检项（悬空范围/零范围/单店/重名）。例外体系已废除（2026-08-18）。变更需用户重新登录生效（JWT 快照）。
import { useEffect, useState } from 'react';

interface Row {
  user: string; display: string; disabled: boolean;
  legacyGroups: string[]; scope: string[]; brands: string[]; categories: string[]; fields: string[];
  scopePermissions: string[];
}
interface Check { kind: string; user?: string; detail: string; level: 'warn' | 'info' }
interface Data { rows: Row[]; checks: Check[]; meta: { users: number; scopePermissions: number; duplicateStoreNames: Array<{ name: string; count: number }> } }

export default function ScopeOverviewPage() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/admin/scope-overview')
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`); return r.json(); })
      .then(setData)
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  if (err) return <div className="p-6 text-sm text-red-600">数据范围总览不可用：{err}</div>;
  if (!data) return <div className="p-6 text-sm text-slate-400">加载中…</div>;

  const rows = data.rows
    .filter((r) => !q || r.user.toLowerCase().includes(q.toLowerCase()) || r.display.includes(q) || r.scope.some((s) => s.includes(q)))
    .sort((a, b) => (a.scope.length === 0 ? 1 : 0) - (b.scope.length === 0 ? 1 : 0) || a.user.localeCompare(b.user));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">数据范围总览</h1>
        <p className="mt-1 text-xs text-slate-400">
          {data.meta.users} 人 · {data.meta.scopePermissions} 个范围 permission ·
          变更需用户<b className="text-amber-600"> 重新登录 </b>生效（JWT 快照）
        </p>
      </div>

      {data.checks.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-800 mb-2">体检项（{data.checks.length}）</h2>
          <ul className="space-y-1 text-xs">
            {data.checks.slice(0, 20).map((c, i) => (
              <li key={i} className={c.level === 'warn' ? 'text-red-600' : 'text-slate-500'}>
                [{c.kind}] {c.user ? <b>{c.user}</b> : ''} {c.detail}
              </li>
            ))}
            {data.checks.length > 20 && <li className="text-slate-400">… 其余 {data.checks.length - 20} 条</li>}
          </ul>
        </section>
      )}

      <input
        className="w-64 rounded border border-slate-200 px-3 py-1.5 text-sm"
        placeholder="搜索用户 / 门店 / 范围…"
        value={q} onChange={(e) => setQ(e.target.value)}
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">门店范围</th>
              <th className="px-3 py-2 font-medium">品牌 / 品类 / 字段</th>
              <th className="px-3 py-2 font-medium">企微组（仅目录对照）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user} className="border-b border-slate-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.display || r.user}
                  <div className="text-[11px] text-slate-400">{r.user}{r.disabled ? ' · 已禁用' : ''}</div>
                </td>
                <td className="px-3 py-2">
                  {r.scope.length ? r.scope.map((s) => (
                    <span key={s} className="mr-1 mb-1 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">{s}</span>
                  )) : <span className="text-xs text-slate-300">—（无显式范围，走旧通道或 deny）</span>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {[...r.brands, ...r.categories, ...r.fields].join(' · ') || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{r.legacyGroups.join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
