'use client';
import { useEffect, useMemo, useState } from 'react';

type QaLog = {
  id: number;
  run_id: string;
  trigger: string;
  check_type: string;
  check_name: string;
  status: 'pass' | 'fail' | 'error' | 'no-data';
  diff: number | null;
  detail: unknown | null;
  run_at: string;
};

type FilterMode = 'all' | 'fail' | 'no-data';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pass: { label: '通过', cls: 'bg-green-100 text-green-700' },
  fail: { label: '失败', cls: 'bg-red-100 text-red-700' },
  error: { label: '异常', cls: 'bg-amber-100 text-amber-700' },
  'no-data': { label: '未到', cls: 'bg-blue-100 text-blue-700' },
};

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
};

const fmtDiff = (diff: number | null) =>
  diff === null || diff === undefined ? '—' : Number(diff).toFixed(2);

const detailSummary = (detail: unknown) => {
  if (detail === null || detail === undefined) return '';
  const s = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

export default function QaPage() {
  const [logs, setLogs] = useState<QaLog[]>([]);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = `/api/admin/qa-log${filter === 'fail' ? '?status=fail' : filter === 'no-data' ? '?status=no-data' : ''}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) throw new Error(j?.error || 'qa_logs 读取失败');
        setLogs(Array.isArray(j.data) ? j.data : []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter]);

  // 顶部摘要：按 check_type 汇总本次加载区间的 pass/fail/noData 计数。
  // no-data 单独计数，不从 else fail++（数据未到 ≠ 失败）。
  const summary = useMemo(() => {
    const m = new Map<string, { pass: number; fail: number; noData: number }>();
    for (const l of logs) {
      const c = m.get(l.check_type) || { pass: 0, fail: 0, noData: 0 };
      if (l.status === 'pass') c.pass++;
      else if (l.status === 'no-data') c.noData++;
      else c.fail++;
      m.set(l.check_type, c);
    }
    return [...m.entries()]
      .map(([type, c]) => ({ type, ...c }))
      .sort((a, b) => b.fail - a.fail || b.noData - a.noData || b.pass - a.pass);
  }, [logs]);

  // 真异常 = fail/error；no-data 独立计数（不混入 badCount，不触发"异常"红色徽章）
  const badCount = logs.filter((l) => l.status === 'fail' || l.status === 'error').length;
  const noDataCount = logs.filter((l) => l.status === 'no-data').length;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">数据质量</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 text-sm rounded ${filter === 'all' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            全部
          </button>
          <button
            onClick={() => setFilter('fail')}
            className={`px-3 py-1 text-sm rounded ${filter === 'fail' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            只看失败/异常
          </button>
          <button
            onClick={() => setFilter('no-data')}
            className={`px-3 py-1 text-sm rounded ${filter === 'no-data' ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            只看未到
          </button>
        </div>
      </div>

      {/* 摘要 */}
      {!loading && !error && summary.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className={`px-3 py-1 rounded ${badCount === 0 && (filter !== 'fail') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
            {filter === 'fail'
              ? `本次加载 ${logs.length} 条异常记录`
              : filter === 'no-data'
                ? `本次加载 ${logs.length} 条未到记录`
                : badCount === 0 && noDataCount === 0
                  ? `✓ 最近 ${logs.length} 条全部通过`
                  : `✗ 最近 ${logs.length} 条中 ${badCount} 条异常${noDataCount ? `、${noDataCount} 条未到` : ''}`}
          </span>
          {summary.map((s) => (
            <span key={s.type} className="px-3 py-1 rounded bg-gray-100 text-gray-700">
              {s.type}：通过 {s.pass} / 失败 {s.fail}{s.noData > 0 ? ` / 未到 ${s.noData}` : ''}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          加载失败：{error}
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">加载中…</div>
      ) : logs.length === 0 ? (
        <div className="text-gray-400 text-sm">
          {filter === 'fail' ? '暂无失败/异常记录' : filter === 'no-data' ? '暂无未到记录' : '暂无巡检记录'}
        </div>
      ) : (
        <table className="w-full text-sm border">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="px-2 py-1">时间</th>
              <th className="px-2 py-1">类型</th>
              <th className="px-2 py-1">检查项</th>
              <th className="px-2 py-1">状态</th>
              <th className="px-2 py-1 text-right">diff</th>
              <th className="px-2 py-1">明细</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => {
              const meta = STATUS_META[l.status] || { label: l.status, cls: 'bg-gray-100 text-gray-700' };
              return (
                <tr key={l.id} className="border-t">
                  <td className="px-2 py-1 tabular-nums whitespace-nowrap">{fmtTime(l.run_at)}</td>
                  <td className="px-2 py-1">
                    <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-xs font-medium">{l.check_type}</span>
                    <span className="ml-1 text-xs text-gray-400">{l.trigger}</span>
                  </td>
                  <td className="px-2 py-1 font-mono text-xs">{l.check_name}</td>
                  <td className="px-2 py-1">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-2 py-1 tabular-nums text-right">{fmtDiff(l.diff)}</td>
                  <td className="px-2 py-1 font-mono text-xs text-gray-600" title={detailSummary(l.detail)}>
                    {detailSummary(l.detail)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
