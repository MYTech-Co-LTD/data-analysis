// web/lib/jobs/monitor/manifest.ts
// 监控扫描桶（架构 §8.1）。4 个节奏：
//   每分钟 service_down；每5分钟 collect_fail/request_fail/token_expire；
//   每小时 data_freshness/contact_sync；每日 data_integrity。
// Phase A 仅前两桶有 evaluator，后两桶空跑（loadRules 空），Phase B 填。
// P1：函数体从 scheduler.ts registerMonitorJobs 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
import type { JobManifest, JobResult } from '../../contracts';
import { runCollectTokenBucket, runDailyBucket, runHourlyBucket, runServiceDownBucket } from '../../monitor/runtime';
import { tryAcquireLock } from '../../scheduler-lock';
import { runningTasks } from '../state';

function monitorManifest(key: string, expr: string, fn: () => Promise<void>): JobManifest {
  return {
    id: key,
    schedule: expr,
    run: async (): Promise<JobResult> => {
      if (!tryAcquireLock(runningTasks, key, `任务 ${key}`)) return { status: 'skipped' };
      try { await fn(); } finally { runningTasks.delete(key); }
      return { status: 'ok' };
    },
  };
}

export const monitorManifests: JobManifest[] = [
  monitorManifest('__monitor_service', '* * * * *', runServiceDownBucket),
  monitorManifest('__monitor_collect_token', '*/5 * * * *', runCollectTokenBucket),
  monitorManifest('__monitor_hourly', '0 * * * *', runHourlyBucket),
  monitorManifest('__monitor_daily', '0 3 * * *', runDailyBucket),
];
