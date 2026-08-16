// web/lib/jobs/contact-sync/manifest.ts
// 通讯录全量兜底同步（平台基础设施，独立于 collect_tasks）。
// 每日 03:17 调 functions/wecom-sync-contacts 全量自愈（架构 §7.1.2）。
// P1：函数体从 scheduler.ts registerContactSyncJob 原样搬入 run（不改进）；cron 注册由薄 scheduler 按 manifest.schedule 完成。
//
// Task 12 写者收编：refresh_role_assignments() 角色推导已由 thin-sync job 接管
// （web/lib/sync/derive-roles.ts 单实现）。通讯录同步后不再调 refresh RPC——
// 薄同步 auto 写入上线日 = refresh cron 停写日（spec §4.5a）。
// 若 wecom-sync-contacts function 内部仍调 refresh，需同步改 function 代码（SSH PUT）。
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
      // TODO(Task 12): 若 wecom-sync-contacts function 内部调 refresh_role_assignments()，
      // 需在 function 代码中移除该调用（薄同步已接管角色推导）。
    } catch (e: unknown) {
      console.error('[scheduler] 通讯录同步异常:', (e as Error).message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
    return { status: 'ok' };
  },
};
