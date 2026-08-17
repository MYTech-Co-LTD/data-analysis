// web/app/admin/permissions/page.tsx
// 权限管理（2026-08-17 Casdoor 上收后收口版）：本页唯一职责 = 「带到期临时例外」（temporary_grants）
// + 变更审计。旧四维模型（用户角色指派/部门四维/角色默认范围 + 个人 override 编辑器）已随
// data_permissions 表删除（185 sunset / W5 写关闭）整体下线——权限真相源 = Casdoor
// （组挂载 / 角色 / Permission 资源勾选），死 tab 不再展示避免误导（用户裁决 2026-08-17）。
// 数据契约（存活通道）：
//   GET  /api/admin/permissions/users  → { users }（例外表单用户选择器）
//   GET  /api/admin/permissions/grants → { grants }（活跃 + 近30天已失效）
//   POST /api/admin/permissions/grants → { wecom_id, dim, value, expires_at, note? }（≤90 天 + 单维 ≤50 条）
//   DELETE /api/admin/permissions/grants?id= → 撤销（revoked_at + 审计 + 缓存失效）
//   GET  /api/admin/permissions/audit?limit=20 → { items }
//   GET  /api/admin/permissions/preview?wecom_id= → 生效权限预览（排障 API，无 UI 入口）
// 品牌数据：GET /api/admin/brands（dim_brand）
// 生效时机：例外通道 RLS 每请求实查（B5 不折叠 claims），撤销/到期即时收口。

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, History, RefreshCw, ShieldCheck, Trash2,
} from 'lucide-react';

// ================= 类型 =================

type User = {
  wecom_id: string; name: string; department_ids: string[];
  role_id: number | null; role_source: 'auto' | 'manual';
};
type AuditItem = {
  id: number; actor_wecom_id: string; actor_name: string | null;
  action: string; subject_type: string; subject_id: string | null;
  payload_before: unknown; payload_after: unknown; created_at: string;
};
type Brand = { system_book_code: string; brand_name: string };
type GrantRow = {
  id: number; user_id: string; dim: string; value: string;
  expires_at: string; revoked_at: string | null; granted_by: string;
  note: string | null; created_at: string;
};
type Json = Record<string, unknown> | null;

// ================= 常量 =================

const SUBJECT_LABEL: Record<string, string> = { user: '用户', dept: '部门', role: '角色' };
const ACTION_LABEL: Record<string, string> = {
  assign_role: '指派角色',
  upsert_data_permission: '更新权限',
  delete_data_permission: '删除 override',
  update_role: '更新角色',
  grant_create: '授予例外',
  grant_revoke: '撤销例外',
};
// 例外维度（temporary_grants.dim，迁移 183 CHECK 四值）；branch 值 = branch_number 全局唯一键（门店键铁律）
const GRANT_DIM_OPTIONS = [
  { value: 'branch_nums', label: '门店', hint: 'branch_number 全局唯一键，如 3120-001' },
  { value: 'brands', label: '品牌', hint: 'system_book_code，如 3120' },
  { value: 'categories', label: '品类', hint: '如 水果 / 标品 / 耗材' },
  { value: 'fields', label: '字段', hint: '当前仅 cost（成本可见）' },
];

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

// 数据库 timestamptz（UTC）→ Asia/Shanghai 本地 datetime-local 值
function fmtList(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 1 && v[0] === '*') return '全部门(*)';
    return v.length ? v.join('、') : '空';
  }
  return v == null ? '未配置' : String(v);
}

function asRecord(v: unknown): Json {
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
    case 'grant_create':
    case 'grant_revoke': {
      const dimLabel = GRANT_DIM_OPTIONS.find(d => d.value === p?.dim)?.label ?? String(p?.dim ?? '?');
      const bits = [`${dimLabel} ${String(p?.value ?? '?')}`];
      if (p?.expires_at) bits.push(`至 ${fmtShanghai(String(p.expires_at))}`);
      if (p?.revoked_at) bits.push(`撤销于 ${fmtShanghai(String(p.revoked_at))}`);
      if (p?.note) bits.push(String(p.note));
      return bits.join('、');
    }
    default:
      return a.action;
  }
}

// ================= 小部件 =================

function useBrands(): Brand[] {
  const [brands, setBrands] = useState<Brand[]>([]);
  useEffect(() => {
    fetch('/api/admin/brands', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (Array.isArray(j.data)) setBrands(j.data as Brand[]); })
      .catch(() => {});
  }, []);
  return brands;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-sm font-medium text-slate-700 mb-1.5">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

function Btn({ children, onClick, variant = 'primary', disabled, danger, type = 'button' }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost'; disabled?: boolean; danger?: boolean; type?: 'button' | 'submit';
}) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
  const cls = danger
    ? 'text-red-600 border border-red-200 hover:bg-red-50'
    : variant === 'primary'
      ? 'bg-primary text-white hover:bg-blue-800'
      : 'text-slate-600 border border-slate-300 hover:bg-slate-50';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${cls}`}>
      {children}
    </button>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone?: 'ok' | 'off' | 'none' | 'warn' }) {
  const cls = tone === 'ok' ? 'bg-green-50 text-green-700 border-green-200'
    : tone === 'off' ? 'bg-slate-100 text-slate-500 border-slate-200'
    : tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-blue-50 text-blue-700 border-blue-200';
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

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

// ================= 例外 tab（Task 17，迁移 183 temporary_grants） =================

function GrantsTab({ users, onChanged }: { users: User[]; onChanged: () => void }) {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const brands = useBrands();
  const [form, setForm] = useState({ wecomId: '', dim: 'branch_nums', value: '', days: 7, note: '' });
  const [showInactive, setShowInactive] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/admin/permissions/grants', { cache: 'no-store' });
      if (!r.ok) { setErr(`例外列表加载失败 ${r.status}`); return; }
      const d = await r.json();
      setGrants(d.grants ?? []);
      setErr('');
    } catch { setErr('例外列表加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const nameOf = (uid: string) => users.find(u => u.wecom_id === uid)?.name ?? uid;
  const dimLabel = (dim: string) => GRANT_DIM_OPTIONS.find(d => d.value === dim)?.label ?? dim;
  const now = Date.now();
  const active = grants.filter(g => !g.revoked_at && new Date(g.expires_at).getTime() > now);
  const inactive = grants.filter(g => g.revoked_at || new Date(g.expires_at).getTime() <= now);

  async function grant() {
    if (!form.wecomId) { setErr('请选择用户'); return; }
    if (!form.value.trim()) { setErr('请填写例外值'); return; }
    const days = Math.floor(Number(form.days));
    if (!(days > 0 && days <= 90)) { setErr('到期天数须在 (0, 90]'); return; }
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/admin/permissions/grants', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wecom_id: form.wecomId, dim: form.dim, value: form.value.trim(),
          expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
          note: form.note.trim() || null,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `授予失败 ${r.status}`); return; }
      toast.success(`已授予例外（${dimLabel(form.dim)} ${form.value.trim()}，${days} 天后到期）`);
      setForm(f => ({ ...f, value: '', note: '' }));
      await load(); onChanged();   // onChanged 刷新审计区
    } catch { setErr('授予失败，请重试'); }
    finally { setSaving(false); }
  }

  async function revoke(id: number) {
    setErr('');
    try {
      const r = await fetch(`/api/admin/permissions/grants?id=${id}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `撤销失败 ${r.status}`); return; }
      toast.success('已撤销（RLS 例外并集即时收口，app 侧缓存 ≤5min 失效）');
      await load(); onChanged();
    } catch { setErr('撤销失败，请重试'); }
  }

  const dimHint = GRANT_DIM_OPTIONS.find(d => d.value === form.dim)?.hint ?? '';

  return (
    <div>
      {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
      <p className="text-xs text-slate-400 mb-3">
        临时例外 = 到期自动失效的临时授权（如临时查看某门店）。不折叠进登录 claims（B5）：RLS 每请求实查并集，
        撤销/到期即时收口；app 侧读取有 ≤5min 缓存。到期 ≤90 天，单用户单维活跃例外 ≤50 条。
      </p>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="用户">
            <select
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
              value={form.wecomId} onChange={e => setForm(f => ({ ...f, wecomId: e.target.value }))}
            >
              <option value="">选择用户…</option>
              {users.map(u => <option key={u.wecom_id} value={u.wecom_id}>{u.name}（{u.wecom_id}）</option>)}
            </select>
          </Field>
          <Field label="维度">
            <select
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
              value={form.dim} onChange={e => setForm(f => ({ ...f, dim: e.target.value, value: '' }))}
            >
              {GRANT_DIM_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}（{d.value}）</option>)}
            </select>
          </Field>
          <Field label="例外值" hint={dimHint}>
            {form.dim === 'brands' ? (
              <select
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
                value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              >
                <option value="">选择品牌…</option>
                {brands.map(b => <option key={b.system_book_code} value={b.system_book_code}>{b.brand_name}（{b.system_book_code}）</option>)}
              </select>
            ) : form.dim === 'categories' ? (
              <select
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
                value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              >
                <option value="">选择品类…</option>
                {['水果', '标品', '耗材'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : form.dim === 'fields' ? (
              <select
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
                value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              >
                <option value="">选择字段…</option>
                <option value="cost">成本可见（cost）</option>
              </select>
            ) : (
              <input
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                placeholder="如 3120-001" value={form.value}
                onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
              />
            )}
          </Field>
          <Field label="到期天数（≤90）">
            <input
              type="number" min={1} max={90}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm tabular-nums"
              value={form.days} onChange={e => setForm(f => ({ ...f, days: Number(e.target.value) }))}
            />
          </Field>
          <Field label="备注（可选）">
            <input
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="授予原因（审计归因）" value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            />
          </Field>
        </div>
        <div className="mt-1">
          <Btn onClick={grant} disabled={saving}>{saving ? '授予中…' : '授予例外'}</Btn>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-sm text-slate-400 text-center">加载中…</div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-700">活跃例外</h3>
            <span className="text-xs text-slate-400 tabular-nums">共 {active.length} 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse tabular-nums">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-4">用户</th>
                  <th className="py-2 pr-4">维度</th>
                  <th className="py-2 pr-4">值</th>
                  <th className="py-2 pr-4">到期</th>
                  <th className="py-2 pr-4">授予人</th>
                  <th className="py-2 pr-4">备注</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {active.map(g => {
                  const soon = new Date(g.expires_at).getTime() - now < 7 * 86_400_000;
                  return (
                    <tr key={g.id} className="border-b border-slate-100">
                      <td className="py-2 pr-4 text-slate-800">{nameOf(g.user_id)}</td>
                      <td className="py-2 pr-4"><Badge>{dimLabel(g.dim)}</Badge></td>
                      <td className="py-2 pr-4 text-slate-800">{g.value}</td>
                      <td className="py-2 pr-4 text-slate-600">
                        {soon ? <Badge tone="warn">{fmtShanghai(g.expires_at)} 即将到期</Badge> : fmtShanghai(g.expires_at)}
                      </td>
                      <td className="py-2 pr-4 text-slate-600">{nameOf(g.granted_by)}</td>
                      <td className="py-2 pr-4 text-xs text-slate-500 max-w-[200px]">
                        <span className="block truncate" title={g.note ?? ''}>{g.note ?? '-'}</span>
                      </td>
                      <td className="py-2">
                        <Btn variant="ghost" danger onClick={() => revoke(g.id)}><Trash2 size={14} /> 撤销</Btn>
                      </td>
                    </tr>
                  );
                })}
                {!active.length && (
                  <tr><td colSpan={7} className="py-6 text-center text-slate-400 text-sm">暂无活跃例外</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {inactive.length > 0 && (
            <div className="mt-6">
              <button
                className="text-xs text-slate-500 hover:text-primary underline"
                onClick={() => setShowInactive(v => !v)}
              >
                {showInactive ? '收起' : '展开'}已失效例外（近30天，{inactive.length} 条）
              </button>
              {showInactive && (
                <div className="overflow-x-auto mt-2">
                  <table className="w-full text-sm border-collapse tabular-nums">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200">
                        <th className="py-2 pr-4">用户</th>
                        <th className="py-2 pr-4">维度</th>
                        <th className="py-2 pr-4">值</th>
                        <th className="py-2 pr-4">状态</th>
                        <th className="py-2 pr-4">到期</th>
                        <th className="py-2 pr-4">撤销于</th>
                        <th className="py-2 pr-4">授予人</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inactive.map(g => (
                        <tr key={g.id} className="border-b border-slate-100 text-slate-400">
                          <td className="py-2 pr-4">{nameOf(g.user_id)}</td>
                          <td className="py-2 pr-4">{dimLabel(g.dim)}</td>
                          <td className="py-2 pr-4">{g.value}</td>
                          <td className="py-2 pr-4">
                            {g.revoked_at ? <Badge tone="off">已撤销</Badge> : <Badge tone="off">已到期</Badge>}
                          </td>
                          <td className="py-2 pr-4">{fmtShanghai(g.expires_at)}</td>
                          <td className="py-2 pr-4">{fmtShanghai(g.revoked_at)}</td>
                          <td className="py-2 pr-4">{nameOf(g.granted_by)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ================= 页面 =================

export default function PermissionsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [error, setError] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  async function loadUsers() {
    try {
      const r = await fetch('/api/admin/permissions/users', { cache: 'no-store' });
      if (!r.ok) { setError(`用户列表加载失败 ${r.status}`); return; }
      const d = await r.json();
      setUsers(d.users ?? []);
    } catch { setError('用户列表加载失败'); }
  }
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
        await Promise.all([loadUsers(), loadAudit()]);
      } finally { setInitialLoading(false); }
    })();
  }, []);

  const reloadAll = () => { loadUsers(); loadAudit(); };

  return (
    <div className="font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold text-slate-800 inline-flex items-center gap-2">
          <ShieldCheck size={20} /> 权限管理 · 临时例外
        </h1>
        <span className="text-xs text-slate-400">带到期临时例外授权 + 变更审计</span>
      </div>
      {/* 真相源引导横幅（185 sunset 后常驻）：常规权限去 Casdoor，本页只管例外 */}
      <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>
          常规权限（组挂载 / 角色 / 看板-品牌-品类-成本能力勾选）的真相源已上收统一身份平台——请在
          <a href="https://sso.shanhaiyiguo.com/login/shanhai" target="_blank" rel="noreferrer" className="mx-1 font-medium underline hover:text-blue-900">Casdoor 管理端</a>
          配置（改动后用户下次登录生效）。本页仅管理「带到期临时例外」（≤90 天自动失效，RLS 每请求实查、撤销即时收口）与审计留痕。
        </span>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      {initialLoading ? (
        <div className="py-16 text-sm text-slate-400 text-center">加载中…</div>
      ) : (
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-6">
        <div>
          <GrantsTab users={users} onChanged={reloadAll} />
        </div>
        <div className="mt-6 xl:mt-0">
          <AuditPanel items={audit} loading={auditLoading} onRefresh={loadAudit} />
        </div>
      </div>
      )}
    </div>
  );
}
