// web/app/admin/capabilities/page.tsx
// W1 Task6：能力目录辅助页（W1 退出判据「辅助页可看 synced 状态」）。
// 2026-08-19 布局重构（用户裁定）：单页长滚动改四标签——概览/数据范围/能力点/对账风险；
//   能力点清单加置顶「全部能力（*）」可复制行，数据范围树加置顶「全门店」行（scope-tree.tsx）。
// 只读观测页：catalog 单真相全量（组/标签/敏感/来源/synced）+ 校验结果（环检测/通配风险）+
// 在线对账红区（E-unknown / E-deprecated 废弃引用 holders / C-sync-failed）。
// 数据契约：GET /api/admin/capabilities（requireAdmin 门禁；synced = 查看即自愈的 add-resource 幂等差集）。
// 增删能力点不改本页——改 view-configs/app 路由后 scan 自动发现（H12 catalog 单真相纪律）。
'use client';

import { useEffect, useState } from 'react';
import { ScopeTree } from '@/components/admin/scope-tree';
import {
  AlertTriangle, BookCheck, CheckCircle2, CircleAlert, Copy, ListTree, RefreshCw, ShieldAlert,
} from 'lucide-react';

// ================= 类型（与 /api/admin/capabilities 契约对齐） =================

type CatalogEntry = {
  key: string; group: string; label: string;
  name?: string; description?: string;
  sensitive?: boolean; source: 'auto' | 'manual';
  displayName?: string;   // 授权名（组|通俗名，Casdoor Custom 粘贴串）
};
type RedEntry = {
  kind: 'E-unknown-key' | 'E-deprecated-key' | 'C-sync-failed' | 'E-global-wildcard';
  key: string; holders: string[]; error?: string;
};
type Payload = {
  catalogV: string;
  breakglass?: string[];   // BREAKGLASS_ADMINS 非空名单（应急后门开启中警示）
  entries: CatalogEntry[];
  deprecated: string[];
  viewGroups: Record<string, { label: string; members: readonly string[] }>;
  cycleCheck: string[];
  wildcardRisk: { risky: readonly string[] };
  synced: { ok: boolean; unknown?: boolean; missing: string[]; added: string[] };
  reconcile: {
    red: RedEntry[];
    minor: { kind: string; key: string }[];
    wildcardHolders: { user: string; wildcard: string }[];
    summary?: { red: number; minor: number };
  } | null;
};

const RED_KIND_LABEL: Record<RedEntry['kind'], string> = {
  'E-unknown-key': '未知 key',
  'E-deprecated-key': '废弃仍引用',
  'C-sync-failed': '注册失败',
  'E-global-wildcard': '全局通配(*)',
};

// 一键复制授权名（组|通俗名）：复制后到 Casdoor permission（Resource type = Custom）粘贴
function CopyName({ text, tone }: { text: string; tone?: 'warn' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="点击复制，到 Casdoor permission（Resource type 选 Custom）的 Resources 框粘贴"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-colors ${
        tone === 'warn'
          ? 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300'
          : copied
            ? 'border-green-200 bg-green-50 text-green-700'
            : 'border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50'
      }`}
    >
      {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}{text}
    </button>
  );
}

// ================= 小部件（样式对齐 /admin/permissions 现有页面） =================

function Badge({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'off' | 'warn' | 'red' }) {
  const cls = tone === 'ok' ? 'bg-green-50 text-green-700 border-green-200'
    : tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : tone === 'red' ? 'bg-red-50 text-red-700 border-red-200'
    : tone === 'off' ? 'bg-slate-100 text-slate-500 border-slate-200'
    : 'bg-blue-50 text-blue-700 border-blue-200';
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

function StatCard({ label, value, tone, icon }: {
  label: string; value: string | number; tone?: 'ok' | 'warn' | 'red'; icon?: React.ReactNode;
}) {
  const cls = tone === 'red' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-green-600' : 'text-slate-800';
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 flex items-center gap-3">
      {icon && <span className={cls}>{icon}</span>}
      <div>
        <div className={`text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

// ================= 标签页 =================

type Tab = 'overview' | 'scope' | 'catalog' | 'risk';
const TABS: Array<{ id: Tab; label: string; badge?: (d: Payload) => number | null }> = [
  { id: 'overview', label: '概览' },
  { id: 'scope', label: '数据范围' },
  { id: 'catalog', label: '能力点' },
  { id: 'risk', label: '对账风险', badge: (d) => d.reconcile?.summary?.red ?? null },
];

// ================= 页面 =================

export default function CapabilitiesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  async function load() {
    try {
      const r = await fetch('/api/admin/capabilities', { cache: 'no-store' });
      if (!r.ok) { setError(`加载失败 ${r.status}`); return; }
      setData((await r.json()) as Payload);
      setError('');
    } catch { setError('加载失败，请重试'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void (async () => { await load(); })(); }, []);
  function refresh() { setLoading(true); void load(); }

  if (loading && !data) return <div className="py-16 text-sm text-slate-400 text-center">加载中…</div>;
  if (!data) return (
    <div className="py-16 text-center">
      <div className="text-sm text-red-600 mb-3">{error || '加载失败'}</div>
      <button onClick={refresh} className="text-sm text-primary hover:underline">重试</button>
    </div>
  );

  const red = data?.reconcile?.red ?? [];
  const wildcards = data?.reconcile?.wildcardHolders ?? [];
  const orphanPerms = (data?.reconcile?.minor ?? []).filter((m) => m.kind === 'M-orphan-permission');
  const missingSet = new Set(data?.synced?.missing ?? []);
  const deprecatedSet = new Set(data?.deprecated ?? []);
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of data?.entries ?? []) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group)!.push(e);
  }
  const hasAlerts = data.cycleCheck.length > 0 || data.synced.unknown || (!data.synced.ok) || !data.reconcile;

  return (
    <div className="font-sans max-w-6xl">
      {/* ---- 页头：标题 + catalog_v + 刷新 + 标签导航 ---- */}
      <div className="mb-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-800 inline-flex items-center gap-2">
            <ListTree size={20} /> 能力目录
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 tabular-nums">catalog_v {data?.catalogV ?? '-'}</span>
            <button onClick={refresh} disabled={loading}
              className="text-xs text-slate-500 hover:text-primary inline-flex items-center gap-1">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        </div>
        {/* 标签条 */}
        <div className="mt-3 flex items-center gap-1 border-b border-slate-200">
          {TABS.map((t) => {
            const badge = t.badge?.(data) ?? null;
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
                  active ? 'border-blue-600 text-blue-700 font-medium'
                    : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {t.label}
                {badge != null && badge > 0 && (
                  <span className="rounded-full bg-red-100 text-red-700 px-1.5 text-[10px] leading-4 tabular-nums">{badge}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      {/* ================ 概览 ================ */}
      {tab === 'overview' && (
        <>
          <div className="mt-4 mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>
              能力点 catalog 单真相 = <code className="text-xs">web/lib/capability-catalog(-.generated).ts</code>；
              新增视图/路由由 scan 自动发现（本页只读）。查看本页即触发 resource 差集自愈（add-resource 幂等只补缺）。
              <b className="block mt-1">授权操作</b>：Casdoor 建/改 permission → Resource type 选 <b>Custom</b> → Resources 框粘贴「能力点」/「数据范围」标签页复制的授权名 → 保存后用户重新登录生效。
            </span>
          </div>

          {data?.breakglass && data.breakglass.length > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <ShieldAlert size={15} className="shrink-0 mt-0.5" />
              <span>
                <b>应急后门开启中</b>（BREAKGLASS_ADMINS）：{data.breakglass.join('、')} —— 名单内用户绕过一切 Casdoor 权限（含管理台门禁）。
                仅限 Casdoor 故障期临时使用，<b>用后即清</b>（服务器 <code className="text-xs">deploy/.env</code> 改空后 <code className="text-xs">docker compose up -d web</code> 重建）。
              </span>
            </div>
          )}

          {hasAlerts && (
            <div className="mb-4 flex flex-col gap-1.5">
              {data.cycleCheck.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <ShieldAlert size={15} className="shrink-0 mt-0.5" />
                  <span>view-group 环引用：{data.cycleCheck.join('、')}（展开会死循环，须先修 catalog）</span>
                </div>
              )}
              {data.synced.unknown && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  <CircleAlert size={15} className="shrink-0 mt-0.5" />
                  <span>Casdoor 不可达：synced 状态未知（降级显示）；每日 03:47 cron 与部署钩子会自动重试。</span>
                </div>
              )}
              {!data.synced.unknown && !data.synced.ok && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  <CircleAlert size={15} className="shrink-0 mt-0.5" />
                  <span>有 {data.synced.missing.length} 个能力点注册 Casdoor 失败（见「对账风险」C-sync-failed）——失败能力永不可配，不会静默。</span>
                </div>
              )}
              {!data.reconcile && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  <CircleAlert size={15} className="shrink-0 mt-0.5" />
                  <span>在线对账不可用（Casdoor permissions 拉取失败）；catalog 清单与校验结果不受影响。</span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <StatCard label="能力点总数" value={data.entries.length} icon={<ListTree size={16} />} />
            <StatCard label="废弃清单" value={data.deprecated.length} tone={data.deprecated.length ? 'warn' : undefined} />
            <StatCard label="对账红区" value={data.reconcile?.summary?.red ?? '-'} tone={red.length ? 'red' : 'ok'}
              icon={red.length ? <ShieldAlert size={16} /> : <CheckCircle2 size={16} />} />
            <StatCard label="未引用（提示）" value={data.reconcile?.summary?.minor ?? '-'} />
            <StatCard label="通配持有者" value={data.reconcile ? wildcards.length : '-'} tone={wildcards.length ? 'warn' : undefined} />
            <StatCard label="synced" value={data.synced.unknown ? '未知' : data.synced.ok ? 'OK' : `缺 ${data.synced.missing.length}`}
              tone={data.synced.unknown ? 'warn' : data.synced.ok ? 'ok' : 'warn'} icon={<BookCheck size={16} />} />
          </div>

          {/* 授权组（view-group） */}
          {data && Object.keys(data.viewGroups).length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-slate-800 mb-2">授权组（view-group，映射在本侧不进 Casdoor policy）</h2>
              <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-2">
                {Object.entries(data.viewGroups).map(([name, def]) => (
                  <div key={name} className="text-sm">
                    <span className="text-slate-800 font-medium">{def.label}</span>
                    <span className="text-slate-400 text-xs ml-2">{name}</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {def.members.map((m) => <Badge key={m}>{m}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* ================ 数据范围 ================ */}
      {tab === 'scope' && (
        <section className="mt-4">
          <ScopeTree />
        </section>
      )}

      {/* ================ 能力点 ================ */}
      {tab === 'catalog' && (
        <section className="mt-4">
          {/* 全部能力（置顶）：通配资源串，粘贴即全能力授权——高风险，警示标注 */}
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2">
            <div className="flex-1">
              <div className="text-sm font-medium text-slate-800 inline-flex items-center gap-2">
                全部能力
                <Badge tone="warn">通配 *</Badge>
              </div>
              <div className="text-xs text-amber-700 mt-0.5">
                授权后命中所有能力点（看板/KPI/门禁/品牌/品类/字段，不含数据范围）——建议仅临时/调试用，常态授权勾具体能力
              </div>
            </div>
            <CopyName text="*" tone="warn" />
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm border-collapse tabular-nums">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-3 py-2 font-medium">组</th>
                  <th className="px-3 py-2 font-medium">标签</th>
                  <th className="px-3 py-2 font-medium">描述</th>
                  <th className="px-3 py-2 font-medium">key</th>
                  <th className="px-3 py-2 font-medium">授权名（复制→Casdoor）</th>
                  <th className="px-3 py-2 font-medium">敏感</th>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 font-medium">synced</th>
                </tr>
              </thead>
              <tbody>
                {[...groups.entries()].map(([group, entries]) => entries.map((e, i) => {
                  const miss = missingSet.has(e.key);
                  const dep = deprecatedSet.has(e.key);
                  return (
                    <tr key={e.key} className={`border-b border-slate-100 ${dep ? 'bg-red-50/60' : ''}`}>
                      <td className="px-3 py-2 text-slate-600">{i === 0 ? group : ''}</td>
                      <td className="px-3 py-2 text-slate-800">
                        {e.label}
                        {dep && <Badge tone="red">废弃</Badge>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 max-w-[260px]">{e.description ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-600 text-xs">{e.key}</td>
                      <td className="px-3 py-2">{e.displayName ? <CopyName text={e.displayName} /> : <span className="text-slate-400">-</span>}</td>
                      <td className="px-3 py-2">{e.sensitive ? <Badge tone="warn">敏感</Badge> : <span className="text-slate-400">-</span>}</td>
                      <td className="px-3 py-2 text-slate-500">{e.source === 'auto' ? 'auto（scan）' : 'manual'}</td>
                      <td className="px-3 py-2">
                        {data?.synced.unknown ? <Badge tone="off">未知</Badge>
                          : miss ? <Badge tone="red">失败</Badge>
                          : <Badge tone="ok">✓</Badge>}
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ================ 对账风险 ================ */}
      {tab === 'risk' && (
        <>
          {/* 红区：对账红条目（E-unknown / E-deprecated 废弃引用 / C-sync-failed） */}
          {data?.reconcile && (
            <section className="mt-4 mb-6">
              <h2 className="text-sm font-semibold text-slate-800 mb-2">对账红区（授权语义 vs catalog）</h2>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                {red.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-slate-400 text-center">无红——permission.resources 引用全部 ∈ catalog∪通配</div>
                ) : (
                  <table className="w-full text-sm border-collapse tabular-nums">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
                        <th className="px-3 py-2 font-medium">级别</th>
                        <th className="px-3 py-2 font-medium">key</th>
                        <th className="px-3 py-2 font-medium">授权对象仍引用（holders）</th>
                        <th className="px-3 py-2 font-medium">详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {red.map((r) => (
                        <tr key={`${r.kind}:${r.key}`} className={`border-b border-slate-100 ${r.kind === 'E-deprecated-key' ? 'bg-red-50/60' : ''}`}>
                          <td className="px-3 py-2"><Badge tone="red">{RED_KIND_LABEL[r.kind]}</Badge></td>
                          <td className="px-3 py-2 text-slate-800">{r.key}</td>
                          <td className="px-3 py-2 text-slate-600">{r.holders.join('、') || '-'}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">
                            {r.kind === 'E-deprecated-key'
                              ? '废弃 key 仍被授权语义覆盖（直接/命名空间通配）——按驱逐判据处理后再下线'
                              : r.kind === 'E-global-wildcard'
                                ? 'permission 持有全局 *（Casdoor 空配置默认值）——改勾具体资源或删除；判定层已去特权，无超权效力'
                                : r.kind === 'C-sync-failed'
                                  ? r.error
                                  : '引用了 catalog 外的 key（反向发现）'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          )}

          {/* 通配持有者（M2 风险面） */}
          {data?.reconcile && wildcards.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-slate-800 mb-2">通配持有者（高风险，M2）</h2>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-sm border-collapse tabular-nums">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
                      <th className="px-3 py-2 font-medium">授权对象（permission）</th>
                      <th className="px-3 py-2 font-medium">通配</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wildcards.map((w, i) => (
                      <tr key={`${w.user}:${w.wildcard}:${i}`} className="border-b border-slate-100">
                        <td className="px-3 py-2 text-slate-800">{w.user}</td>
                        <td className="px-3 py-2"><Badge tone="warn">{w.wildcard}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 孤儿 permission（未挂角色未直挂用户——授予不了任何人的误导配置） */}
          {data?.reconcile && orphanPerms.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold text-slate-800 mb-2">孤儿 permission（未挂角色/用户，配置无效）</h2>
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
                      <th className="px-3 py-2 font-medium">permission</th>
                      <th className="px-3 py-2 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orphanPerms.map((m) => (
                      <tr key={m.key} className="border-b border-slate-100">
                        <td className="px-3 py-2 text-slate-800">{m.key}</td>
                        <td className="px-3 py-2 text-xs text-amber-700">未挂任何角色也未直挂用户——授予不了任何人；在 Casdoor 挂角色或删除，避免误导</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
