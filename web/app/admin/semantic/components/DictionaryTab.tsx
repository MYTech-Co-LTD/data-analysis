'use client';
import { Fragment, useState, useEffect } from 'react';

type Row = {
  kind: string;
  code: string;
  name: string;
  description: string | null;
  formula: string | null;
  measure_type: string;
  additive: boolean;
  cost_sensitive: boolean | null;
  unit: string | null;
  source_table: string | null;
  source_column: string | null;
};

export default function DictionaryTab() {
  const [data, setData] = useState<Row[]>([]);
  const [filter, setFilter] = useState<'all' | 'metric' | 'dimension'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/semantic/dictionary')
      .then((r) => r.json())
      .then((j) => setData(j.data || []));
  }, []);

  const rows = data.filter((r) => filter === 'all' || r.kind === filter);
  const dataSource = (r: Row) => (r.source_table ? `${r.source_table}.${r.source_column || ''}` : '-');

  return (
    <div>
      <div className="flex gap-2 mb-3">
        {(['all', 'metric', 'dimension'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-sm rounded-md ${filter === f ? 'bg-primary text-white' : 'border'}`}
          >
            {f === 'all' ? '全部' : f === 'metric' ? '指标' : '维度'}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500 self-center">{rows.length} 项</span>
      </div>
      <table className="w-full text-sm border tabular-nums">
        <thead className="bg-gray-50">
          <tr className="text-left">
            <th className="px-2 py-1">类型</th>
            <th className="px-2 py-1">code</th>
            <th className="px-2 py-1">名称</th>
            <th className="px-2 py-1">分类</th>
            <th className="px-2 py-1">数据源（表.列）</th>
            <th className="px-2 py-1">单位</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.code}>
              <tr
                className="border-t hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpanded(expanded === r.code ? null : r.code)}
              >
                <td className="px-2 py-1">{r.kind === 'metric' ? '指标' : '维度'}</td>
                <td className="px-2 py-1 font-mono">{r.code}</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.measure_type}</td>
                <td className="px-2 py-1 font-mono text-xs">{dataSource(r)}</td>
                <td className="px-2 py-1">{r.unit || '-'}</td>
              </tr>
              {expanded === r.code && (
                <tr className="border-t bg-gray-50">
                  <td colSpan={6} className="px-2 py-2 text-xs text-gray-600 space-y-1">
                    <div><b>口径：</b>{r.description || '-'}</div>
                    <div><b>公式：</b>{r.formula || '-'}</div>
                    <div><b>数据源：</b>{r.source_table ? `${r.source_table}.${r.source_column || ''}` : '-'}</div>
                    <div><b>属性：</b>{r.additive ? '可加' : '不可加(比率须重算)'}{r.cost_sensitive ? ' · 成本敏感' : ''}</div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
