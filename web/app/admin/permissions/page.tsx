// web/app/admin/permissions/page.tsx
// 权限管理：用户角色指派（manual 不被同步覆盖）+ 生效权限预览
'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

type Role = { id: number; code: string; name: string };
type Dept = { id: string; name: string };
type User = {
  wecom_id: string; name: string; department_ids: string[];
  role_id: number | null; role_source: 'auto' | 'manual';
};
type Preview = {
  effective: {
    role_code: string | null; branch_nums: string[]; brands: string[];
    categories: string[]; can_see_cost: boolean;
  } | null;
  layers: {
    user: User | null;
    role: Role | null;
    departments: (Dept & { branch_nums: string[]; can_see_cost: boolean })[];
    permissions: { subject_type: string; subject_id: string; can_see_cost: boolean; expires_at: string | null; note: string | null }[];
  };
};

export default function PermissionsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; data: Preview } | null>(null);
  const [error, setError] = useState('');

  const deptName = useMemo(() => {
    const m = new Map(depts.map(d => [d.id, d.name]));
    return (ids: string[]) => ids.map(i => m.get(i) ?? i).join('、') || '-';
  }, [depts]);

  async function load() {
    const r = await fetch('/api/admin/permissions/users', { cache: 'no-store' });
    if (!r.ok) { setError(`加载失败 ${r.status}`); return; }
    const d = await r.json();
    setUsers(d.users ?? []); setRoles(d.roles ?? []); setDepts(d.departments ?? []);
  }
  useEffect(() => { load(); }, []);

  async function assign(u: User, roleId: number | null) {
    setSaving(u.wecom_id);
    const r = await fetch('/api/admin/permissions/users', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wecom_id: u.wecom_id, role_id: roleId }),
    });
    setSaving(null);
    if (!r.ok) { setError(`保存失败 ${r.status}`); return; }
    await load();
  }

  async function showPreview(wecomId: string) {
    const r = await fetch(`/api/admin/permissions/preview?wecom_id=${encodeURIComponent(wecomId)}`, { cache: 'no-store' });
    if (!r.ok) { setError(`预览失败 ${r.status}`); return; }
    setPreview({ id: wecomId, data: await r.json() });
  }

  const filtered = users.filter(u =>
    !search || u.name?.includes(search) || u.wecom_id.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-6 max-w-6xl mx-auto font-sans">
      <h1 className="text-xl font-semibold text-slate-800 mb-1">权限管理</h1>
      <p className="text-sm text-slate-500 mb-4">
        角色指派（manual 不被同步覆盖；选「自动」恢复同步赋值）。用户重新登录后新权限生效。
      </p>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="搜索姓名 / 企微 ID"
        className="mb-4 w-72 rounded border border-slate-300 px-3 py-1.5 text-sm"
      />

      <table className="w-full text-sm border-collapse tabular-nums">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-4">姓名</th>
            <th className="py-2 pr-4">部门</th>
            <th className="py-2 pr-4">角色</th>
            <th className="py-2 pr-4">来源</th>
            <th className="py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(u => (
            <tr key={u.wecom_id} className="border-b border-slate-100">
              <td className="py-2 pr-4 text-slate-800">{u.name ?? u.wecom_id}</td>
              <td className="py-2 pr-4 text-slate-600">{deptName(u.department_ids)}</td>
              <td className="py-2 pr-4">
                <select
                  value={u.role_source === 'manual' ? (u.role_id ?? '') : ''}
                  disabled={saving === u.wecom_id}
                  onChange={e => assign(u, e.target.value ? Number(e.target.value) : null)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="">自动{u.role_source === 'auto' && u.role_id
                    ? `（${roles.find(r => r.id === u.role_id)?.name ?? u.role_id}）` : ''}</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="py-2 pr-4">
                <span className={u.role_source === 'manual' ? 'text-blue-700' : 'text-slate-400'}>
                  {u.role_source === 'manual' ? '手动' : '自动'}
                </span>
              </td>
              <td className="py-2">
                <button onClick={() => showPreview(u.wecom_id)}
                  className="text-blue-700 hover:underline text-sm">生效预览</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-lg shadow-lg p-6 w-[560px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-slate-800 mb-3">生效权限 - {preview.id}</h2>
            <PreviewView data={preview.data} />
            <button onClick={() => setPreview(null)}
              className="mt-4 text-sm text-slate-500 hover:underline">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

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
        `${d.name}：门店 ${d.branch_nums?.join(',') ?? '*'}${d.can_see_cost ? '，可见成本' : ''}`).join('；') || '-'} />
      <Row label="个人 override" value={data.layers.permissions.filter(p => p.subject_type === 'user')
        .map(p => `${p.note ?? ''}${p.expires_at ? `（至 ${p.expires_at.slice(0, 10)}）` : ''}`).join('；') || '无'} />
    </div>
  );
}
