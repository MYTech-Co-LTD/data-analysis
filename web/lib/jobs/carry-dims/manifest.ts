// web/lib/jobs/carry-dims/manifest.ts
// C3: 维表 carry 定时兜底（每天 04:33，避开通讯录 03:17；对齐原 registerCarryDimsJob）。
// P1：函数体从 scheduler.ts registerCarryDimsJob 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { AGENT_API_KEY, DUCKDB_URL } from '../env';
import { runningTasks } from '../state';

export const carryDimsManifest: JobManifest = {
  id: '__carry_dims',
  schedule: '33 4 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__carry_dims';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      console.log('[scheduler] ⏰ 维表 carry 定时兜底触发');
      const resp = await fetch(`${DUCKDB_URL}/carry-dims`, {
        method: 'POST', headers: { 'x-agent-key': AGENT_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[scheduler] carry-dims 结果:', resp.status, data);
    } catch (e: unknown) {
      console.error('[scheduler] carry-dims 异常:', (e as Error).message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};
