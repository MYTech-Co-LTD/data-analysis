// web/lib/jobs/target-close/manifest.ts
// D: 目标固化定时兜底（每天 05:10，C1 daily compute 之后；end_date<today 的 active 目标自动固化）。
// P1：函数体从 scheduler.ts registerTargetCloseJob 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

export const targetCloseManifest: JobManifest = {
  id: '__target_close',
  schedule: '10 5 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__target_close';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      console.log('[scheduler] ⏰ 目标固化定时触发（end_date<today 的 active 目标）');
      const dueRes = await fetch(`${POSTGREST_URL}/rpc/get_due_targets`, {
        method: 'POST',
        headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const due: { id: number }[] = await dueRes.json().catch(() => []);
      for (const t of due) {
        const cr = await fetch(`${POSTGREST_URL}/rpc/close_target`, {
          method: 'POST',
          headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_target_id: t.id }),
        });
        const data = await cr.json().catch(() => ({}));
        console.log(`[scheduler] close_target(${t.id}):`, (data as Record<string, unknown>)?.ok, JSON.stringify(data));
      }
    } catch (e: unknown) {
      console.error('[scheduler] target_close 异常:', (e as Error).message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};
