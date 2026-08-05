// web/app/admin/sources/monitor/page.tsx（采集监控）
'use client';

import { useState, useEffect } from 'react';

interface Log {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  rows_collected: number;
  error_message: string;
  collect_tasks: {
    name: string;
    data_sources: { name: string };
  };
}

// collect_tasks 行（/api/admin/collect-tasks 返回）：last_run_at 为心跳，用于采集停陈旧检测
interface CollectTask {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  schedule_cron: string;
  enabled: boolean;
  last_run_at: string;
  next_run_at: string;
  data_sources: { name: string } | null;
}

export default function CollectMonitorPage() {
  const [stats, setStats] = useState({
    total: 0,
    enabled: 0,
    disabled: 0,
    success_today: 0,
    failed_today: 0
  });
  const [logs, setLogs] = useState<Log[]>([]);
  const [tasks, setTasks] = useState<CollectTask[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    try {
      // 获取统计数据
      const statsRes = await fetch('/api/admin/collect-stats');
      const statsData = await statsRes.json();
      setStats(statsData);

      // 获取最近日志
      const logsRes = await fetch('/api/admin/collect-logs?limit=20');
      const logsData = await logsRes.json();
      setLogs(logsData.data || []);

      // 获取任务列表（last_run_at 心跳 → 采集停陈旧高亮）
      const tasksRes = await fetch('/api/admin/collect-tasks');
      const tasksData = await tasksRes.json();
      setTasks(tasksData.data || []);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }




  function formatDuration(ms: number) {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  }

  // 陈旧阈值：与 lib/monitor/evaluators/collect-stall.ts 的 stallMinutesFor 同口径
  // 分钟级任务（minute 字段含 * 或 /，如 */5 8-23 * * *）→ 15 分钟；日任务（0 3 * * *）→ 26h。
  function stallMinutesFor(cron: string): number {
    const minuteField = (cron ?? '').trim().split(/\s+/)[0] ?? '';
    if (minuteField.includes('*') || minuteField.includes('/')) return 15;
    return 26 * 60;
  }

  function formatCron(cron: string) {
    const cronMap: Record<string, string> = {
      '*/5 8-23 * * *': '每 5 分钟 (8-23点)',
      '3-59/5 8-23 * * *': '每 5 分钟 (8-23点)',
      '1-59/5 8-23 * * *': '每 5 分钟 (8-23点)',
      '2-59/5 8-23 * * *': '每 5 分钟 (8-23点)',
      '0 * * * *': '每小时',
      '0 */6 * * *': '每 6 小时',
      '0 2 * * *': '每天凌晨 2 点',
      '0 2 * * 1': '每周一凌晨 2 点'
    };
    return cronMap[cron] || cron;
  }

  // 距今时长：「xx 分钟前 / xx 小时前 / xx 天前」，never → '-'
  function formatElapsed(lastRunAt: string): string {
    if (!lastRunAt) return '-';
    const lastMs = new Date(lastRunAt).getTime();
    if (Number.isNaN(lastMs)) return '-';
    const mins = Math.round((Date.now() - lastMs) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
  }

  // 采集停判定：启用 且 有心跳 且 距今时长 > 按 cron 推导的阈值 → 陈旧（标红）
  // 未启用 / 从未运行（无 last_run_at）→ 不判定（与 collect_stall evaluator 一致）
  function isTaskStale(task: CollectTask): boolean {
    if (!task.enabled || !task.last_run_at) return false;
    const lastMs = new Date(task.last_run_at).getTime();
    if (Number.isNaN(lastMs)) return false;
    return (Date.now() - lastMs) / 60000 > stallMinutesFor(task.schedule_cron);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">采集监控</h1>

      {loading ? (
        <div className="text-center py-10 text-gray-500">加载中...</div>
      ) : (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-5 gap-4 mb-6">
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-gray-800">{stats.total}</div>
              <div className="text-sm text-gray-500">总任务数</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-green-600">{stats.enabled}</div>
              <div className="text-sm text-gray-500">启用</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-gray-400">{stats.disabled}</div>
              <div className="text-sm text-gray-500">禁用</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-green-500">{stats.success_today}</div>
              <div className="text-sm text-gray-500">今日成功</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-3xl font-bold text-red-500">{stats.failed_today}</div>
              <div className="text-sm text-gray-500">今日失败</div>
            </div>
          </div>

          {/* 任务运行状态（last_run_at 陈旧高亮：采集停守护 Task 4） */}
          <div className="bg-white rounded-lg shadow mb-6">
            <div className="p-4 border-b font-bold">任务运行状态</div>
            {tasks.length === 0 ? (
              <div className="p-10 text-center text-gray-500">暂无任务数据</div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">任务</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">数据源</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">频率</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">启用</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">最近执行</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {tasks.map((task) => {
                    const stale = isTaskStale(task);
                    return (
                      <tr key={task.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">{task.name}</td>
                        <td className="px-4 py-3 text-sm">{task.data_sources?.name || '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">{formatCron(task.schedule_cron)}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded text-xs ${
                            task.enabled ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {task.enabled ? '启用' : '禁用'}
                          </span>
                        </td>
                        <td className={`px-4 py-3 text-sm ${stale ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                          <div>
                            {stale ? '⚠ ' : ''}{task.last_run_at ? formatElapsed(task.last_run_at) : '从未运行'}
                          </div>
                          {task.last_run_at && (
                            <div className="text-xs text-gray-400">{new Date(task.last_run_at).toLocaleString()}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* 最近执行记录 */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b font-bold">最近执行记录</div>
            {logs.length === 0 ? (
              <div className="p-10 text-center text-gray-500">暂无执行记录</div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">任务</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">数据源</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">状态</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">开始时间</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">耗时</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">采集数量</th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">错误信息</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {logs.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">{log.collect_tasks?.name || '-'}</td>
                      <td className="px-4 py-3 text-sm">{log.collect_tasks?.data_sources?.name || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs ${
                          log.status === 'success' ? 'bg-green-50 text-green-600' :
                          log.status === 'running' ? 'bg-primary/10 text-primary' :
                          'bg-red-50 text-red-600'
                        }`}>
                          {log.status === 'success' ? '成功' :
                           log.status === 'running' ? '运行中' : '失败'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {new Date(log.started_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm">{formatDuration(log.duration_ms)}</td>
                      <td className="px-4 py-3 text-sm">{log.rows_collected || 0}</td>
                      <td className="px-4 py-3 text-sm text-red-600">
                        {log.error_message || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}