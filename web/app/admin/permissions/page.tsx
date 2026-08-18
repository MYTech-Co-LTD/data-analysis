// web/app/admin/permissions/page.tsx
// 权限管理（2026-08-18 例外废除后收口版）：本页职责 = 权限变更审计（permission_audit）。
// 旧四维模型与例外体系均已下线——权限真相源 = Casdoor（角色 / Permission 资源勾选，
// 门店范围 = 范围|X 资源唯一真相，2026-08-18 废除组织架构推导与例外体系）。
// 数据契约（存活通道）：
//   GET  /api/admin/permissions/audit?limit=20 → { items }
//   GET  /api/admin/permissions/preview?wecom_id= → 生效权限预览（排障 API，无 UI 入口）
// 例外（temporary_grants）与四维授权已废除（185 sunset / 197 例外废除），不再有写入口。

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { History, RefreshCw, ShieldCheck } from 'lucide-react';

// ================= 类型 =================

type AuditItem = {
  id: number; actor_wecom_id: string; actor_name: string | null;
  action: string; subject_type: string; subject_id: string | null;
  payload_before: unknown; payload_after: unknown; created_at: string;
};

// ================= 常量 =================

const SUBJECT_LABEL: Record<string, string> = { user: '用户', dept: '部门', role: '角色' };
const ACTION_LABEL: Record<string, string> = {
  assign_role: '指派角色',
  upsert_data_permission: '更新权限',
  delete_data_permission: '删除 override',
  update_role: '更新角色',
};

function fmtShanghai(ts: string | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
}

function fmtList(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 1 && v[0] === '*') return '全部门(*)';
    return v.length ? v.join('、') : '空';
  }
  return v == null ? '未配置' : String(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function auditDetail(a: AuditItem): string {
  const after = asRecord(a.payload_after);
  const before = asRecord(a.payload_before);
  const p = after ?? before;
  switch (a.action) {
    case 'assign_role': {
      const rid = p?.role_id ?? null;
      return rid == null ? '恢复自动角色' : `指派角色 #${String(rid)}`;
    }
    case 'upsert_data_permission':
    case 'delete_data_permission': {
      const bits: string[] = [];
      if (p?.branch_nums !== undefined && p?.branch_nums !== null) bits.push(`门店 ${fmtList(p.branch_nums)}`);
      if (p?.brands !== undefined && p?.brands !== null) bits.push(`品牌 ${fmtList(p.brands)}`);
      if (p?.categories !== undefined && p?.categories !== null) bits.push(`品类 ${fmtList(p.categories)}`);
      if (p?.can_see_cost !== undefined && p?.can_see_cost !== null) bits.push(`成本${p.can_see_cost ? '可见' : '不可见'}`);
      if (p?.expires_at) bits.push(`至 ${String(p.expires_at).slice(0, 10)}`);
      if (p?.note) bits.push(String(p.note));
      if (bits.length) return bits.join('、');
      return a.action === 'delete_data_permission' ? '删除 override（恢复继承）' : '更新权限';
    }
    case 'update_role': {
      const bits: string[] = [];
      if ('default_landing' in (after ?? {})) bits.push(`落地页 ${after?.default_landing ?? '空'}`);
      if ('default_metric' in (after ?? {})) bits.push(`指标 ${after?.default_metric ?? '空'}`);
      if ('is_active' in (after ?? {})) bits.push(`状态 ${after?.is_active ? '启用' : '停用'}`);
      if (p?.branch_nums !== undefined && p?.branch_nums !== null) bits.push(`门店 ${fmtList(p.branch_nums)}`);
      if (p?.brands !== undefined && p?.brands !== null) bits.push(`品牌 ${fmtList(p.brands)}`);
      if (p?.categories !== undefined && p?.categories !== null) bits.push(`品类 ${fmtList(p.categories)}`);
      if (p?.can_see_cost !== undefined && p?.can_see_cost !== null) bits.push(`成本${p.can_see_cost ? '可见' : '不可见'}`);
      return bits.join('、') || '更新角色';
    }
    default:
      return a.action;
  }
}

// ================= 小部件 =================

function AuditPanel({ items, loading, onRefresh }: {
  items: AuditItem[]; loading: boolean; onRefresh: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-800 inline-flex items-center gap-1.5">
          <History size={15} /> 最近变更
        </h3>
        <button onClick={onRefresh} disabled={loading} className="text-xs text-slate-500 hover:text-primary inline-flex items-center gap-1" title="刷新">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-400">暂无变更记录</div>
        ) : (
          <table className="w-full text-xs border-collapse tabular-nums">
            <thead className="sticky top-0 bg-slate-50">
              <tr className="text-left text-slate-500">
                <th className="px-3 py-1.5 font-medium">时间</th>
                <th className="px-2 py-1.5 font-medium">操作者</th>
                <th className="px-2 py-1.5 font-medium">主体</th>
                <th className="px-2 py-1.5 font-medium">动作</th>
                <th className="px-3 py-1.5 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map(a => (
                <tr key={a.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{fmtShanghai(a.created_at)}</td>
                  <td className="px-2 py-1.5 text-slate-700 whitespace-nowrap">{a.actor_name ?? a.actor_wecom_id}</td>
                  <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">
                    {SUBJECT_LABEL[a.subject_type] ?? a.subject_type}
                    {a.subject_id ? <span className="text-slate-400"> #{a.subject_id}</span> : null}
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">{ACTION_LABEL[a.action] ?? a.action}</td>
                  <td className="px-3 py-1.5 text-slate-500 break-words">{auditDetail(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ================= 页面 =================

export default function PermissionsPage() {
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [error, setError] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  async function loadAudit() {
    setAuditLoading(true);
    try {
      const r = await fetch('/api/admin/permissions/audit?limit=20', { cache: 'no-store' });
      if (!r.ok) { setError(`审计加载失败 ${r.status}`); return; }
      const d = await r.json();
      setAudit(d.items ?? []);
    } catch { setError('审计加载失败'); }
    finally { setAuditLoading(false); }
  }

  useEffect(() => {
    void (async () => {
      try {
        await loadAudit();
      } finally { setInitialLoading(false); }
    })();
  }, []);

  return (
    <div className="font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold text-slate-800 inline-flex items-center gap-2">
          <ShieldCheck size={20} /> 权限管理
        </h1>
        <span className="text-xs text-slate-400">权限变更审计</span>
      </div>
      {/* 真相源引导横幅（185 sunset + 197 例外废除后常驻）：常规权限去 Casdoor，门店范围 = 范围|X 资源 */}
      <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
        <span>
          权限真相源已上收统一身份平台——请在
          <a href="https://sso.shanhaiyiguo.com/login/shanhai" target="_blank" rel="noreferrer" className="mx-1 font-medium underline hover:text-blue-900">Casdoor 管理端</a>
          配置：能力点 / 品牌 / 品类 / 字段勾选，门店范围 = `范围|X` 资源（2026-08-18 起唯一真相，无范围 = 空集 deny；例外体系已废除）。改动后用户下次登录生效。本页仅展示权限变更审计留痕。
        </span>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      {initialLoading ? (
        <div className="py-16 text-sm text-slate-400 text-center">加载中…</div>
      ) : (
        <div>
          <AuditPanel items={audit} loading={auditLoading} onRefresh={loadAudit} />
        </div>
      )}
    </div>
  );
}
