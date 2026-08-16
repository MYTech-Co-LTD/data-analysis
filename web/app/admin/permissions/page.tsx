// web/app/admin/permissions/page.tsx
// 权限管理：用户 / 部门 / 角色 / 例外 四 tab + StorePicker（品牌感知门店选择器）
//          + 个人 override 编辑器（四维 + 到期 + note + 删除恢复继承）+ 审计区（最近变更）
// 数据契约：web/app/api/admin/permissions/*（Task 2）：
//   GET  /users            → { users, roles, departments }
//   PUT  /users            → { wecom_id, role_id } 角色指派（manual 不被同步覆盖）
//   GET  /users/:wecom_id  → { user, override | null }
//   PUT  /users/:wecom_id  → 四维+expires_at+note（null=未配；全 null → 删行恢复继承）
//   DELETE /users/:wecom_id → 删 override 恢复继承
//   GET  /depts            → { departments: DeptRow[] }
//   PUT  /depts            → { id, branch_nums?, can_see_cost? }
//   GET  /roles            → { roles: RoleRow[] }
//   PUT  /roles/:id        → 参数 + 默认范围四维
//   GET  /audit?limit=20   → { items: AuditItem[] }
//   GET  /grants           → { grants: GrantRow[] }（Task 17：活跃 + 近30天已失效）
//   POST /grants           → { wecom_id, dim, value, expires_at, note? }（≤90 天 + 单维 ≤50 条）
//   DELETE /grants?id=     → 撤销（写 revoked_at + 审计 + 服务端同步清 RT 缓存）
// 门店数据：GET /api/admin/branches（branch_admin_v，含 war_zone / region_l2）
// 品牌数据：GET /api/admin/brands（dim_brand）
// 生效时机：权限改动后用户下次登录（重新签发 JWT）生效。
'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, Building2, History, MapPin, Pencil, RefreshCw,
  Search, ShieldCheck, Timer, Trash2, Users, X,
} from 'lucide-react';

// ================= 类型 =================

type RoleBrief = { id: number; code: string; name: string };
type User = {
  wecom_id: string; name: string; department_ids: string[];
  role_id: number | null; role_source: 'auto' | 'manual';
};
type DeptBrief = { id: string; name: string };
type DeptRow = {
  id: string; name: string; parent_id: string | null; is_active: boolean;
  branch_nums: string[] | null; can_see_cost: boolean | null;
  auto_role_id: number | null; auto_role_name: string | null;
};
type RoleRow = RoleBrief & {
  default_landing: string | null; default_metric: string | null;
  visible_panels: string[]; is_active: boolean;
  branch_nums: string[] | null; brands: string[] | null;
  categories: string[] | null; can_see_cost: boolean | null;
};
type OverrideRow = {
  id: number; branch_nums: string[] | null; brands: string[] | null;
  categories: string[] | null; can_see_cost: boolean | null;
  expires_at: string | null; note: string | null;
};
type AuditItem = {
  id: number; actor_wecom_id: string; actor_name: string | null;
  action: string; subject_type: string; subject_id: string | null;
  payload_before: unknown; payload_after: unknown; created_at: string;
};
type Brand = { system_book_code: string; brand_name: string };
type Branch = {
  system_book_code: string; branch_num: string; branch_name: string;
  war_zone: string | null; region_l2: string | null; city: string | null;
};
type Preview = {
  effective: {
    role_code: string | null; branch_nums: string[]; brands: string[];
    categories: string[]; can_see_cost: boolean;
  } | null;
  layers: {
    user: User | null;
    role: RoleBrief | null;
    departments: (DeptBrief & { branch_nums: string[] | null; can_see_cost: boolean | null })[];
    permissions: { subject_type: string; subject_id: string; can_see_cost: boolean; expires_at: string | null; note: string | null }[];
  };
};
type GrantRow = {
  id: number; user_id: string; dim: string; value: string;
  expires_at: string; revoked_at: string | null; granted_by: string;
  note: string | null; created_at: string;
};
type TabKey = 'users' | 'depts' | 'roles' | 'grants';
type Json = Record<string, unknown> | null;

// ================= 常量 =================

const CATEGORY_OPTIONS = ['水果', '标品', '耗材', '其他'];
const PANEL_OPTIONS = [
  { value: 'targets', label: '目标达成' },
  { value: 'category_analysis', label: '品类分析' },
  { value: 'cost', label: '成本' },
];
const METRIC_OPTIONS = [
  { value: 'sale', label: '销售额 (sale)' },
  { value: 'outbound_amt', label: '出库金额 (outbound_amt)' },
  { value: 'outbound_profit', label: '出库毛利 (outbound_profit)' },
];
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

// ================= 工具 =================

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
function toDatetimeLocal(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}`;
}

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

function scopeSummary(branch: string[] | null, brands: string[] | null, cats: string[] | null, cost: boolean | null): string {
  return `门店 ${fmtList(branch)} · 品牌 ${fmtList(brands)} · 品类 ${fmtList(cats)} · 成本 ${cost === null ? '未配' : cost ? '可见' : '不可见'}`;
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

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-lg shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[88vh] overflow-auto`}
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
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

// 品牌 / 品类多选：null=未配置（继承）；空数组表示「已配置但一项未选」
function DimCheckboxes({ options, value, onChange, inheritLabel = '继承' }: {
  options: { value: string; label: string }[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  inheritLabel?: string;
}) {
  const isNull = value === null;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const checked = !isNull && value.includes(o.value);
          return (
            <label
              key={o.value}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm cursor-pointer select-none ${checked ? 'border-primary bg-blue-50 text-primary' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              <input
                type="checkbox"
                className="accent-blue-700"
                checked={checked}
                disabled={isNull}
                onChange={e => {
                  const cur = value ?? [];
                  onChange(e.target.checked ? [...cur, o.value] : cur.filter(v => v !== o.value));
                }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {isNull
          ? <span className="text-slate-400">{inheritLabel}（不覆盖基底）</span>
          : <span className="text-slate-400 tabular-nums">已配置 {value.length} 项</span>}
        {!isNull && (
          <button type="button" onClick={() => onChange(null)} className="text-slate-500 hover:text-primary underline">
            设为{inheritLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// 成本三态：null=继承 / true=可见 / false=不可见
function CostTriState({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  const opts = [
    { v: null, label: '继承' },
    { v: true, label: '可见' },
    { v: false, label: '不可见' },
  ] as const;
  return (
    <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
      {opts.map((o, i) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-3 py-1.5 ${i > 0 ? 'border-l border-slate-200' : ''} ${value === o.v ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// 门店选择器：品牌 Tab + 战区/二级区域分组 + 搜索 + 全选/清空 + 全部门(*) 开关
// 值：branch_nums: string[] | null（null=未配置/继承；['*']=全部门；数组=指定门店）
function StorePicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [sbc, setSbc] = useState('');
  const [branchData, setBranchData] = useState<{ sbc: string; branches: Branch[]; loadErr: string } | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/admin/brands', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        const list = Array.isArray(j.data) ? (j.data as Brand[]) : [];
        setBrands(list);
        if (list.length) setSbc(list[0].system_book_code);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!sbc) return;
    let cancelled = false;
    fetch(`/api/admin/branches?sbc=${encodeURIComponent(sbc)}&page=1&page_size=500`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled) setBranchData({ sbc, branches: Array.isArray(j.data) ? (j.data as Branch[]) : [], loadErr: '' }); })
      .catch(() => { if (!cancelled) setBranchData({ sbc, branches: [], loadErr: '门店列表加载失败' }); });
    return () => { cancelled = true; };
  }, [sbc]);

  const branches = useMemo(
    () => (branchData?.sbc === sbc ? branchData.branches : []),
    [branchData, sbc],
  );
  const loading = branchData === null || branchData.sbc !== sbc;
  const loadErr = branchData?.sbc === sbc ? branchData.loadErr : '';

  const mode: 'inherit' | 'all' | 'specific' = value === null ? 'inherit'
    : value.length === 1 && value[0] === '*' ? 'all'
    : 'specific';
  const selected = useMemo(() => new Set(value ?? []), [value]);
  const filtered = useMemo(
    () => branches.filter(b => !q.trim() || b.branch_num.includes(q.trim()) || b.branch_name.includes(q.trim())),
    [branches, q],
  );
  const groups = useMemo(() => {
    const map = new Map<string, { region: string; items: Branch[] }[]>();
    for (const b of filtered) {
      const wz = b.war_zone || '未分区';
      const rgn = b.region_l2 || '未分二级区域';
      let arr = map.get(wz);
      if (!arr) { arr = []; map.set(wz, arr); }
      let rg = arr.find(x => x.region === rgn);
      if (!rg) { rg = { region: rgn, items: [] }; arr.push(rg); }
      rg.items.push(b);
    }
    return [...map.entries()];
  }, [filtered]);

  function toggle(num: string) {
    const s = new Set(value && value[0] !== '*' ? value : []);
    if (s.has(num)) s.delete(num); else s.add(num);
    onChange(s.size ? [...s] : null); // 全去勾 → 恢复继承（避免空数组覆盖=放行）
  }
  function setMode(m: 'inherit' | 'all' | 'specific') {
    if (m === 'inherit') onChange(null);
    else if (m === 'all') onChange(['*']);
    // 全部门(*) → 指定门店：先置空再进入 specific（避免 ['*'] 残留导致 no-op）
    else onChange(value && value[0] === '*' ? [] : selected.size ? [...selected] : []);
  }
  function selectAllBrand() {
    const base = value && value[0] !== '*' ? new Set(value) : new Set<string>();
    for (const n of filtered) base.add(n.branch_num);
    onChange([...base]);
  }
  function clear() { onChange(null); }

  const countLabel = mode === 'inherit' ? '未配置（继承）'
    : mode === 'all' ? '全部门(*)'
    : `已选 ${selected.size} 家（按门店号去重）`;

  return (
    <div className="rounded-md border border-slate-200 p-3 bg-slate-50/50">
      {/* 顶部：三态模式 + 全选/清空 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
          {([['inherit', '继承'], ['all', '全部门(*)'], ['specific', '指定门店']] as const).map(([m, label], i) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 ${i > 0 ? 'border-l border-slate-200' : ''} ${mode === m ? 'bg-primary text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 tabular-nums">{countLabel}</span>
        <div className="ml-auto flex gap-3">
          <button type="button" onClick={selectAllBrand} className="text-xs text-primary hover:underline">全选（当前结果）</button>
          <button type="button" onClick={clear} className="text-xs text-slate-500 hover:underline">清空</button>
        </div>
      </div>

      {/* 品牌 Tab + 搜索 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="flex gap-1 flex-wrap">
          {brands.map(b => (
            <button
              key={b.system_book_code}
              type="button"
              onClick={() => setSbc(b.system_book_code)}
              className={`px-2.5 py-1 text-xs rounded ${sbc === b.system_book_code ? 'bg-primary text-white' : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-100'}`}
            >
              {b.system_book_code} {b.brand_name}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索门店号 / 名称"
            className="pl-7 pr-2 py-1 text-xs rounded border border-slate-300 w-48"
          />
        </div>
      </div>

      {/* 战区 → 二级区域 → 门店 */}
      <div className="max-h-64 overflow-y-auto border border-slate-200 rounded bg-white">
        {loading && <div className="p-3 text-xs text-slate-400">加载门店…</div>}
        {loadErr && <div className="p-3 text-xs text-red-600">{loadErr}</div>}
        {!loading && !loadErr && filtered.length === 0 && <div className="p-3 text-xs text-slate-400">无匹配门店</div>}
        {groups.map(([wz, regions]) => (
          <div key={wz} className="border-b border-slate-100 last:border-0">
            <div className="px-2 py-1 bg-slate-50 text-xs font-medium text-slate-600 flex items-center gap-1">
              <MapPin size={12} /> {wz}
            </div>
            {regions.map(rg => (
              <div key={rg.region} className="border-t border-slate-50">
                <div className="px-3 py-0.5 text-[11px] text-slate-400">{rg.region}</div>
                <div className="px-2 pb-1 grid grid-cols-1 md:grid-cols-2 gap-0.5">
                  {rg.items.map(b => (
                    <label
                      key={`${b.system_book_code}-${b.branch_num}`}
                      className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded text-xs cursor-pointer hover:bg-slate-50 ${selected.has(b.branch_num) ? 'text-primary' : 'text-slate-700'}`}
                    >
                      <input
                        type="checkbox"
                        className="accent-blue-700"
                        checked={selected.has(b.branch_num)}
                        disabled={mode !== 'specific'}
                        onChange={() => toggle(b.branch_num)}
                      />
                      <span className="text-[10px] text-slate-400 font-medium tabular-nums">{b.system_book_code}·</span>
                      <span className="tabular-nums font-medium">{b.branch_num}</span>
                      <span className="truncate">{b.branch_name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 门店键铁律提示条 */}
      <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
        <span>
          门店键铁律：branch_num 跨品牌重复（3120 与 64188 各自从 1 编号，128 个同号但对应不同物理门店）。
          选择器按品牌分组仅为勾选便利，存储仍只写 branch_nums；生效过滤为 (品牌 AND 门店) 双重匹配，跨品牌同号不冲突。
        </span>
      </div>
    </div>
  );
}

// ================= 用户 tab =================

function UsersTab({ users, roles, departments, onChanged }: {
  users: User[]; roles: RoleBrief[]; departments: DeptBrief[];
  onChanged: () => void;
}) {
  const [search, setSearch] = useState('');
  const [overrideUser, setOverrideUser] = useState<User | null>(null);
  const [preview, setPreview] = useState<{ id: string; data: Preview } | null>(null);
  const [err, setErr] = useState('');

  const deptMap = useMemo(() => new Map(departments.map(d => [d.id, d.name])), [departments]);
  const deptName = (ids: string[]) => ids.map(i => deptMap.get(i) ?? i).join('、') || '-';

  async function showPreview(wecomId: string) {
    setErr('');
    try {
      const r = await fetch(`/api/admin/permissions/preview?wecom_id=${encodeURIComponent(wecomId)}`, { cache: 'no-store' });
      if (!r.ok) { setErr(`预览失败 ${r.status}`); return; }
      setPreview({ id: wecomId, data: await r.json() });
    } catch { setErr('预览加载失败'); }
  }

  const filtered = users.filter(u =>
    !search || u.name?.includes(search) || u.wecom_id.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索姓名 / 企微 ID"
            className="pl-8 pr-3 py-1.5 rounded border border-slate-300 text-sm w-72"
          />
        </div>
        <span className="text-xs text-slate-400 tabular-nums">共 {filtered.length} 人</span>
        <span className="text-xs text-slate-400 ml-auto">
          职位角色由统一身份平台维护 ✎{' '}
          <a href="https://sso.shanhaiyiguo.com/login/shanhai" target="_blank" rel="noreferrer"
             className="text-blue-700 hover:underline">Casdoor 管理端</a>
          （此处只读；同步更新后自动生效）
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse tabular-nums">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-4">姓名</th>
              <th className="py-2 pr-4">部门</th>
              <th className="py-2 pr-4">角色</th>
              <th className="py-2 pr-4">单独授权</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.wecom_id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-800">{u.name ?? u.wecom_id}</td>
                <td className="py-2 pr-4 text-slate-600">{deptName(u.department_ids)}</td>
                <td className="py-2 pr-4">
                  {u.role_source === 'manual' && u.role_id
                    ? <Badge tone="ok">{roles.find(r => r.id === u.role_id)?.name ?? `角色#${u.role_id}`}（手动）</Badge>
                    : u.role_id
                      ? <Badge tone="off">{roles.find(r => r.id === u.role_id)?.name ?? `角色#${u.role_id}`}（自动）</Badge>
                      : <Badge tone="off">未指派</Badge>}
                </td>
                <td className="py-2 pr-4">
                  <Btn variant="ghost" onClick={() => setOverrideUser(u)}>
                    <Pencil size={14} /> 单独授权
                  </Btn>
                </td>
                <td className="py-2">
                  <button onClick={() => showPreview(u.wecom_id)} className="text-blue-700 hover:underline text-sm">生效预览</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {overrideUser && (
        <OverrideEditor user={overrideUser} onClose={() => setOverrideUser(null)} onChanged={() => { setOverrideUser(null); onChanged(); }} />
      )}
      {preview && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-lg shadow-lg p-6 w-[560px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-slate-800 mb-3">生效权限 - {preview.id}</h2>
            <PreviewView data={preview.data} />
            <button onClick={() => setPreview(null)} className="mt-4 text-sm text-slate-500 hover:underline">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

// 个人 override 编辑器：四维 + expires_at + note；维留空=继承（PUT null）；删除=恢复继承
function OverrideEditor({ user, onClose, onChanged }: {
  user: User; onClose: () => void; onChanged: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasOverride, setHasOverride] = useState(false);
  const [err, setErr] = useState('');
  const brands = useBrands();
  const [form, setForm] = useState({
    branchNums: null as string[] | null,
    brands: null as string[] | null,
    categories: null as string[] | null,
    canSeeCost: null as boolean | null,
    expiresAt: '',
    note: '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/admin/permissions/users/${encodeURIComponent(user.wecom_id)}`, { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        const ov = (j.override ?? null) as OverrideRow | null;
        setHasOverride(!!ov);
        setForm({
          branchNums: ov?.branch_nums ?? null,
          brands: ov?.brands ?? null,
          categories: ov?.categories ?? null,
          canSeeCost: ov?.can_see_cost ?? null,
          expiresAt: toDatetimeLocal(ov?.expires_at ?? null),
          note: ov?.note ?? '',
        });
      } catch { if (!cancelled) setErr('加载 override 失败'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [user.wecom_id]);

  async function save() {
    setSaving(true); setErr('');
    const body = {
      branch_nums: form.branchNums && form.branchNums.length ? form.branchNums : null,
      brands: form.brands && form.brands.length ? form.brands : null,
      categories: form.categories && form.categories.length ? form.categories : null,
      can_see_cost: form.canSeeCost,
      expires_at: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      note: form.note.trim() || null,
    };
    const allNull = (body.branch_nums ?? null) === null && (body.brands ?? null) === null
      && (body.categories ?? null) === null && (body.can_see_cost ?? null) === null;
    try {
      const r = await fetch(`/api/admin/permissions/users/${encodeURIComponent(user.wecom_id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `保存失败 ${r.status}`); return; }
      toast.success(allNull ? '已恢复继承，用户重新登录后生效' : '已保存单独授权，用户重新登录后生效');
      onChanged();
    } catch { setErr('保存失败，请重试'); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!confirm(`删除 ${user.name ?? user.wecom_id} 的单独授权并恢复继承？`)) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch(`/api/admin/permissions/users/${encodeURIComponent(user.wecom_id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `删除失败 ${r.status}`); return; }
      toast.success('已删除 override，用户重新登录后恢复继承');
      onChanged();
    } catch { setErr('删除失败，请重试'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`单独授权 - ${user.name ?? user.wecom_id}`} onClose={onClose} wide>
      {loading ? <div className="py-6 text-sm text-slate-400">加载中…</div> : (
        <div>
          {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
          <Field label="品牌范围" hint="留空=继承（不覆盖角色∪部门基底）">
            <DimCheckboxes
              options={brands.map(b => ({ value: b.system_book_code, label: `${b.system_book_code} ${b.brand_name}` }))}
              value={form.brands}
              onChange={v => setForm(f => ({ ...f, brands: v }))}
            />
          </Field>
          <Field label="品类范围" hint="留空=继承">
            <DimCheckboxes
              options={CATEGORY_OPTIONS.map(c => ({ value: c, label: c }))}
              value={form.categories}
              onChange={v => setForm(f => ({ ...f, categories: v }))}
            />
          </Field>
          <Field label="门店范围" hint="留空=继承；全部门(*) = 放行全部门店">
            <StorePicker value={form.branchNums} onChange={v => setForm(f => ({ ...f, branchNums: v }))} />
          </Field>
          <Field label="成本可见" hint={form.canSeeCost === null ? '继承 = 不覆盖基底' : form.canSeeCost ? '覆盖为：可见成本' : '覆盖为：隐藏成本'}>
            <CostTriState value={form.canSeeCost} onChange={v => setForm(f => ({ ...f, canSeeCost: v }))} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="到期时间（留空=永久）" hint="到期后该 override 自动失效（继承恢复）">
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
            <Field label="备注">
              <input
                value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                placeholder="如：临时授权 - 华东大促"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </Field>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-3">
            {hasOverride ? (
              <Btn danger disabled={saving} onClick={remove}>
                <Trash2 size={14} /> 删除恢复继承
              </Btn>
            ) : <span />}
            <div className="flex gap-2">
              <Btn variant="ghost" onClick={onClose}>取消</Btn>
              <Btn disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Btn>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ================= 部门 tab =================

function DeptsTab({ departments, onChanged }: { departments: DeptRow[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<DeptRow | null>(null);
  const [err, setErr] = useState('');

  return (
    <div>
      {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
      <p className="text-xs text-slate-400 mb-3">
        部门层只配置「门店范围 + 成本」两维（品牌/品类仅角色/个人层）；自动角色来自部门→角色映射（通讯录同步维护），只读。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse tabular-nums">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-4">部门</th>
              <th className="py-2 pr-4">门店范围</th>
              <th className="py-2 pr-4">成本</th>
              <th className="py-2 pr-4">自动角色</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {departments.map(d => (
              <tr key={d.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-800">{d.name}</td>
                <td className="py-2 pr-4">
                  {d.branch_nums === null
                    ? <Badge tone="warn">未配置</Badge>
                    : d.branch_nums.length === 1 && d.branch_nums[0] === '*'
                      ? <Badge tone="ok">全部门(*)</Badge>
                      : <span title={d.branch_nums.join('、')}>{d.branch_nums.length} 家</span>}
                </td>
                <td className="py-2 pr-4">
                  {d.can_see_cost === null
                    ? <Badge tone="none">未配置</Badge>
                    : d.can_see_cost ? <Badge tone="ok">可见</Badge> : <Badge tone="off">不可见</Badge>}
                </td>
                <td className="py-2 pr-4 text-slate-600">{d.auto_role_name ?? '-'}</td>
                <td className="py-2">
                  <Btn variant="ghost" onClick={() => setEdit(d)}><Pencil size={14} /> 编辑</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {departments.length === 0 && <p className="text-sm text-slate-400 py-4">暂无部门（通讯录同步后出现）</p>}

      {edit && <DeptEditor dept={edit} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); onChanged(); }} setErr={setErr} />}
    </div>
  );
}

function DeptEditor({ dept, onClose, onChanged, setErr }: {
  dept: DeptRow; onClose: () => void; onChanged: () => void; setErr: (s: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [branchNums, setBranchNums] = useState<string[] | null>(dept.branch_nums);
  const [canSeeCost, setCanSeeCost] = useState<boolean | null>(dept.can_see_cost);

  async function save() {
    setSaving(true); setErr('');
    try {
      const r = await fetch('/api/admin/permissions/depts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: dept.id,
          branch_nums: branchNums && branchNums.length ? branchNums : null,
          can_see_cost: canSeeCost,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `保存失败 ${r.status}`); return; }
      toast.success(`已保存部门「${dept.name}」权限，用户重新登录后生效`);
      onChanged();
    } catch { setErr('保存失败，请重试'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`部门权限 - ${dept.name}`} onClose={onClose} wide>
      <Field label="门店范围" hint="未配置=不补充部门层（用户门店范围由角色/个人层决定）">
        <StorePicker value={branchNums} onChange={setBranchNums} />
      </Field>
      <Field label="成本" hint={canSeeCost === null ? '未配置 = 不覆盖' : canSeeCost ? '部门层覆盖为：可见成本' : '部门层覆盖为：隐藏成本'}>
        <CostTriState value={canSeeCost} onChange={setCanSeeCost} />
      </Field>
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Btn>
      </div>
    </Modal>
  );
}

// ================= 角色 tab =================

function RolesTab({ roles, onChanged }: { roles: RoleRow[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<RoleRow | null>(null);
  const [err, setErr] = useState('');

  return (
    <div>
      {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
      <p className="text-xs text-slate-400 mb-3">
        角色层 = UI 参数（落地页/默认指标/可见面板/启用）+ 默认范围四维（作为所有该角色用户的基底，个人/部门层可覆盖）。
        职位档案与授职在统一身份平台（<a href="https://sso.shanhaiyiguo.com/login/shanhai" target="_blank" rel="noreferrer"
          className="text-blue-700 hover:underline">Casdoor 管理端</a>）维护——此处仅编辑本系统侧的角色默认数据范围 / UI 参数。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse tabular-nums">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-4">角色</th>
              <th className="py-2 pr-4">落地页</th>
              <th className="py-2 pr-4">默认指标</th>
              <th className="py-2 pr-4">可见面板</th>
              <th className="py-2 pr-4">默认范围</th>
              <th className="py-2 pr-4">状态</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(r => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-800">{r.name}<span className="text-slate-400 text-xs ml-1">({r.code})</span></td>
                <td className="py-2 pr-4 text-slate-600">{r.default_landing ?? '-'}</td>
                <td className="py-2 pr-4 text-slate-600">{r.default_metric ?? '-'}</td>
                <td className="py-2 pr-4">
                  <div className="flex gap-1 flex-wrap">
                    {PANEL_OPTIONS.filter(p => (r.visible_panels ?? []).includes(p.value)).map(p => (
                      <Badge key={p.value}>{p.label}</Badge>
                    ))}
                    {!(r.visible_panels ?? []).length && <span className="text-slate-400 text-xs">-</span>}
                  </div>
                </td>
                <td className="py-2 pr-4 text-xs text-slate-500 max-w-[260px]">
                  <span className="block truncate" title={scopeSummary(r.branch_nums, r.brands, r.categories, r.can_see_cost)}>
                    {scopeSummary(r.branch_nums, r.brands, r.categories, r.can_see_cost)}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  {r.is_active ? <Badge tone="ok">启用</Badge> : <Badge tone="off">停用</Badge>}
                </td>
                <td className="py-2">
                  <Btn variant="ghost" onClick={() => setEdit(r)}><Pencil size={14} /> 编辑</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && <RoleEditor role={edit} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); onChanged(); }} setErr={setErr} />}
    </div>
  );
}

function RoleEditor({ role, onClose, onChanged, setErr }: {
  role: RoleRow; onClose: () => void; onChanged: () => void; setErr: (s: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const brands = useBrands();
  const [form, setForm] = useState(() => ({
    defaultLanding: role.default_landing ?? '',
    defaultMetric: role.default_metric ?? '',
    visiblePanels: Array.isArray(role.visible_panels) ? role.visible_panels : [],
    isActive: role.is_active,
    branchNums: role.branch_nums,
    brands: role.brands,
    categories: role.categories,
    canSeeCost: role.can_see_cost,
  }));

  const metricOptions = useMemo(() => {
    const list = [...METRIC_OPTIONS];
    if (form.defaultMetric && !list.some(o => o.value === form.defaultMetric)) {
      list.push({ value: form.defaultMetric, label: `${form.defaultMetric}（自定义）` });
    }
    return list;
  }, [form.defaultMetric]);

  async function save() {
    setSaving(true); setErr('');
    const body = {
      default_landing: form.defaultLanding.trim() || null,
      default_metric: form.defaultMetric || null,
      visible_panels: form.visiblePanels,
      is_active: form.isActive,
      branch_nums: form.branchNums && form.branchNums.length ? form.branchNums : null,
      brands: form.brands && form.brands.length ? form.brands : null,
      categories: form.categories && form.categories.length ? form.categories : null,
      can_see_cost: form.canSeeCost,
    };
    try {
      const r = await fetch(`/api/admin/permissions/roles/${role.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `保存失败 ${r.status}`); return; }
      toast.success(`已保存角色「${role.name}」，用户重新登录后生效`);
      onChanged();
    } catch { setErr('保存失败，请重试'); }
    finally { setSaving(false); }
  }

  function togglePanel(v: string) {
    setForm(f => ({ ...f, visiblePanels: f.visiblePanels.includes(v) ? f.visiblePanels.filter(x => x !== v) : [...f.visiblePanels, v] }));
  }

  return (
    <Modal title={`角色编辑 - ${role.name}（${role.code}）`} onClose={onClose} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="默认落地页">
          <input
            value={form.defaultLanding}
            onChange={e => setForm(f => ({ ...f, defaultLanding: e.target.value }))}
            placeholder="/ 或 /my-store"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </Field>
        <Field label="默认指标">
          <select
            value={form.defaultMetric}
            onChange={e => setForm(f => ({ ...f, defaultMetric: e.target.value }))}
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">未设置</option>
            {metricOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="可见面板" hint="控制导航/面板可见性">
        <div className="flex flex-wrap gap-1.5">
          {PANEL_OPTIONS.map(p => (
            <label
              key={p.value}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm cursor-pointer select-none ${form.visiblePanels.includes(p.value) ? 'border-primary bg-blue-50 text-primary' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
            >
              <input type="checkbox" className="accent-blue-700" checked={form.visiblePanels.includes(p.value)} onChange={() => togglePanel(p.value)} />
              {p.label}
            </label>
          ))}
        </div>
      </Field>
      <Field label="启用状态">
        <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="accent-blue-700" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} />
          {form.isActive ? '启用' : '停用'}
        </label>
      </Field>
      <div className="border-t border-slate-200 pt-3">
        <div className="text-sm font-medium text-slate-700 mb-1.5">默认范围（该角色用户的基底）</div>
        <p className="text-xs text-slate-400 mb-3">留空 = 该维不提供默认（个人/部门层可覆盖）。</p>
        <Field label="品牌范围">
          <DimCheckboxes
            options={brands.map(b => ({ value: b.system_book_code, label: `${b.system_book_code} ${b.brand_name}` }))}
            value={form.brands}
            onChange={v => setForm(f => ({ ...f, brands: v }))}
            inheritLabel="未配置"
          />
        </Field>
        <Field label="品类范围">
          <DimCheckboxes
            options={CATEGORY_OPTIONS.map(c => ({ value: c, label: c }))}
            value={form.categories}
            onChange={v => setForm(f => ({ ...f, categories: v }))}
            inheritLabel="未配置"
          />
        </Field>
        <Field label="门店范围">
          <StorePicker value={form.branchNums} onChange={v => setForm(f => ({ ...f, branchNums: v }))} />
        </Field>
        <Field label="成本" hint={form.canSeeCost === null ? '未配置 = 不提供默认' : form.canSeeCost ? '默认可见成本' : '默认隐藏成本'}>
          <CostTriState value={form.canSeeCost} onChange={v => setForm(f => ({ ...f, canSeeCost: v }))} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Btn>
      </div>
    </Modal>
  );
}

// ================= 生效预览（保留） =================

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex py-1 text-sm">
      <div className="w-28 shrink-0 text-slate-500">{label}</div>
      <div className="text-slate-800 tabular-nums">{value}</div>
    </div>
  );
}

function PreviewView({ data }: { data: Preview }) {
  const e = data.effective;
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-700 mt-2 mb-1">合成结果（重新登录后写入 JWT）</h3>
      <Row label="角色" value={e?.role_code ?? '-'} />
      <Row label="门店范围" value={e?.branch_nums?.join(', ') ?? '-'} />
      <Row label="品牌范围" value={e?.brands?.join(', ') ?? '-'} />
      <Row label="品类范围" value={e?.categories?.join(', ') ?? '-'} />
      <Row label="可见成本" value={e ? (e.can_see_cost ? '是' : '否') : '-'} />
      <h3 className="text-sm font-medium text-slate-700 mt-4 mb-1">分层来源</h3>
      <Row label="角色层" value={data.layers.role ? `${data.layers.role.name}（${data.layers.user?.role_source}）` : '未指派'} />
      <Row label="部门层" value={data.layers.departments.map(d =>
        `${d.name}：门店 ${d.branch_nums?.join(',') ?? '未配置'}${d.can_see_cost === null ? '' : d.can_see_cost ? '，可见成本' : '，隐藏成本'}`).join('；') || '-'} />
      <Row label="个人 override" value={data.layers.permissions.filter(p => p.subject_type === 'user')
        .map(p => `${p.note ?? ''}${p.expires_at ? `（至 ${p.expires_at.slice(0, 10)}）` : ''}`).join('；') || '无'} />
    </div>
  );
}

// ================= 审计区 =================

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
  const [tab, setTab] = useState<TabKey>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [roleBriefs, setRoleBriefs] = useState<RoleBrief[]>([]);
  const [userDepts, setUserDepts] = useState<DeptBrief[]>([]);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [error, setError] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  async function loadUsers() {
    try {
      const r = await fetch('/api/admin/permissions/users', { cache: 'no-store' });
      if (!r.ok) { setError(`用户列表加载失败 ${r.status}`); return; }
      const d = await r.json();
      setUsers(d.users ?? []); setRoleBriefs(d.roles ?? []); setUserDepts(d.departments ?? []);
    } catch { setError('用户列表加载失败'); }
  }
  async function loadDepts() {
    try {
      const r = await fetch('/api/admin/permissions/depts', { cache: 'no-store' });
      if (!r.ok) { setError(`部门列表加载失败 ${r.status}`); return; }
      const d = await r.json();
      setDepartments(d.departments ?? []);
    } catch { setError('部门列表加载失败'); }
  }
  async function loadRoles() {
    try {
      const r = await fetch('/api/admin/permissions/roles', { cache: 'no-store' });
      if (!r.ok) { setError(`角色列表加载失败 ${r.status}`); return; }
      const d = await r.json();
      setRoles(d.roles ?? []);
    } catch { setError('角色列表加载失败'); }
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
        await Promise.all([loadUsers(), loadDepts(), loadRoles(), loadAudit()]);
      } finally { setInitialLoading(false); }
    })();
  }, []);

  const reloadAll = () => {
    loadUsers(); loadDepts(); loadRoles(); loadAudit();
  };

  const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
    { key: 'users', label: '用户', icon: <Users size={16} /> },
    { key: 'depts', label: '部门', icon: <Building2 size={16} /> },
    { key: 'roles', label: '角色', icon: <ShieldCheck size={16} /> },
    { key: 'grants', label: '例外', icon: <Timer size={16} /> },
  ];

  return (
    <div className="font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-semibold text-slate-800 inline-flex items-center gap-2">
          <ShieldCheck size={20} /> 权限管理
        </h1>
        <span className="text-xs text-slate-400">用户 / 部门 / 角色 / 例外授权 + 变更审计</span>
      </div>
      <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>权限改动后，用户下次登录（重新签发 JWT）生效。</span>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      {initialLoading ? (
        <div className="py-16 text-sm text-slate-400 text-center">加载中…</div>
      ) : (
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:gap-6">
        <div>
          <div className="flex gap-1 border-b border-slate-200 mb-4">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-t ${tab === t.key ? 'bg-primary text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          {tab === 'users' && <UsersTab users={users} roles={roleBriefs} departments={userDepts} onChanged={reloadAll} />}
          {tab === 'depts' && <DeptsTab departments={departments} onChanged={reloadAll} />}
          {tab === 'roles' && <RolesTab roles={roles} onChanged={reloadAll} />}
          {tab === 'grants' && <GrantsTab users={users} onChanged={reloadAll} />}
        </div>
        <div className="mt-6 xl:mt-0">
          <AuditPanel items={audit} loading={auditLoading} onRefresh={loadAudit} />
        </div>
      </div>
      )}
    </div>
  );
}
