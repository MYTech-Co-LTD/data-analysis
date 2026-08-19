// web/app/report/detail/page.tsx
// 推送明细链接落地页（缺口 2 / §12.2 修复）：detail_url = /report/detail?branch=...&brand=...&category=...&jwt=<10min代签>
//   消费代签 JWT：以其为 PostgREST Bearer → RLS（scope_match_v2 读 data_scope）按用户门店/品牌/品类裁剪。
//   报表中心重构后 /report 单数路由不存在 → 此前链接 404/回首页；本页重建明细落地。
//   ⚠ 不读会话登录态——权限完全由 URL 携带的 10min 代签 JWT 决定（RLS 强制执行）。
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';

interface MetricRow {
  metric_code: string;
  metric_name: string;
  actual_value: number;
  target_value: number;
  achievement_rate: number;
  unit?: string;
}

async function queryAchievement(jwt: string): Promise<MetricRow[]> {
  const resp = await fetch(
    `${POSTGREST_URL}/report_achievement_gen?select=metric_code,metric_name,actual_value,target_value,achievement_rate,unit&order=metric_code`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  );
  if (!resp.ok) throw new Error(`query achievement ${resp.status}`);
  const rows = (await resp.json()) as MetricRow[];
  // 聚合：同一 metric 多行（多 target 行）SUM actual/target，达成率重算
  const agg = new Map<string, MetricRow & { _a: number; _t: number }>();
  for (const r of rows) {
    const cur = agg.get(r.metric_code) ?? { ...r, actual_value: 0, target_value: 0, _a: 0, _t: 0 };
    cur._a += Number(r.actual_value) || 0;
    cur._t += Number(r.target_value) || 0;
    cur.actual_value = cur._a;
    cur.target_value = cur._t;
    cur.achievement_rate = cur._t ? (cur._a / cur._t) * 100 : 0;
    agg.set(r.metric_code, cur);
  }
  return [...agg.values()];
}

const fmt = (n: number): string => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(n));

export default async function ReportDetailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const sp = await searchParams;
  const jwt = Array.isArray(sp.jwt) ? sp.jwt[0] : sp.jwt;
  const branch = Array.isArray(sp.branch) ? sp.branch[0] : sp.branch;
  const brand = Array.isArray(sp.brand) ? sp.brand[0] : sp.brand;
  const category = Array.isArray(sp.category) ? sp.category[0] : sp.category;

  if (!jwt) {
    return (
      <main className="p-6 font-sans">
        <h1 className="text-lg font-semibold">数据日报</h1>
        <p className="text-sm text-slate-500">链接缺少访问凭证（jwt），可能已过期或未生成完整。请重新接收推送。</p>
      </main>
    );
  }

  let metrics: MetricRow[] = [];
  let error: string | null = null;
  try {
    metrics = await queryAchievement(jwt);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // scope 摘要（RLS 已按 JWT data_scope 裁剪；展示参数仅供参考）
  const scopeNote = [
    branch && branch !== '*' ? `门店：${branch}` : branch === '*' ? '门店：全部' : '',
    brand ? `品牌：${brand}` : '',
    category ? `品类：${category}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <main className="p-6 font-sans">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">📊 数据日报</h1>
        {scopeNote && <span className="text-xs text-slate-500">{scopeNote}</span>}
      </div>
      {error ? (
        <p className="text-sm text-red-600">加载失败：{error}（若 JWT 过期请重新接收推送）</p>
      ) : metrics.length === 0 ? (
        <p className="text-sm text-slate-500">当前范围暂无目标数据（可能权限范围为空或数据未就绪）。</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b text-left text-slate-500">
              <th className="py-2 pr-4">指标</th>
              <th className="py-2 pr-4 text-right">实际</th>
              <th className="py-2 pr-4 text-right">目标</th>
              <th className="py-2 text-right">达成率</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.metric_code} className="border-b">
                <td className="py-2 pr-4 font-medium">{m.metric_name}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt(m.actual_value)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt(m.target_value)}</td>
                <td className="py-2 text-right tabular-nums font-medium">{m.achievement_rate.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
