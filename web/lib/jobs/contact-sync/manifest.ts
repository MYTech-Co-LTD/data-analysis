// web/lib/jobs/contact-sync/manifest.ts
// 通讯录全量兜底同步（平台基础设施，独立于 collect_tasks）。
// 每日 03:17 调 functions/wecom-sync-contacts 全量自愈（架构 §7.1.2）。
// P1：函数体从 scheduler.ts registerContactSyncJob 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_BASE, INSFORGE_API_KEY } from '../env';
import { runningTasks } from '../state';

export const contactSyncManifest: JobManifest = {
  id: '__contact_sync',
  schedule: '17 3 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__contact_sync';
    if (!tryAcquireLock(runningTasks, JOB_KEY, '通讯录同步', { logSkip: true })) return { status: 'skipped' };
    try {
      console.log('[scheduler] ⏰ 通讯录全量兜底同步触发');
      const resp = await fetch(`${INSFORGE_API_BASE}/functions/wecom-sync-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INSFORGE_API_KEY}` },
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[scheduler] 通讯录同步结果:', resp.status, data);
    } catch (e: unknown) {
      console.error('[scheduler] 通讯录同步异常:', (e as Error).message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};
