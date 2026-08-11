// web/lib/jobs/dim-customer/manifest.ts
// A4: dim_customer 派生定时（每天 04:20，carry-dims 04:33 前→carry 自动 COPY 当日新客户）。
// P1：函数体从 scheduler.ts registerDimCustomerJob 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { AGENT_API_KEY, DUCKDB_URL } from '../env';
import { runningTasks } from '../state';

export const dimCustomerManifest: JobManifest = {
  id: '__dim_customer',
  schedule: '20 4 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__dim_customer';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      console.log('[scheduler] ⏰ dim_customer 派生定时触发');
      const resp = await fetch(`${DUCKDB_URL}/derive-dim-customer`, {
        method: 'POST', headers: { 'x-agent-key': AGENT_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[scheduler] derive-dim-customer 结果:', resp.status, data);
    } catch (e: unknown) {
      console.error('[scheduler] derive-dim-customer 异常:', (e as Error).message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};
