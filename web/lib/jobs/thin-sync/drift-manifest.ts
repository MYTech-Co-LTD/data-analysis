// web/lib/jobs/thin-sync/drift-manifest.ts
// Drift 三向对账 job（spec §4.5 / Task 12）：
//   每日跑一次，产出 diff1/diff2/diff3 报告 → 告警。
//   spec: drift 三向对账（每日 job）：diff1/diff2/diff3 语义见组件 §4.5。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { runningTasks } from '../state';
import { runDriftReport, assessAlerts } from '../../sync/drift';

export const driftReportManifest: JobManifest = {
  id: '__drift_report',
  // 每日 04:23 跑 drift（Asia/Shanghai，与通讯录 03:17 错开）
  schedule: '23 4 * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__drift_report';
    if (!tryAcquireLock(runningTasks, JOB_KEY, 'drift 三向对账')) return { status: 'skipped' };

    try {
      console.log('[drift] 开始三向对账');

      const report = await runDriftReport();
      const alerts = assessAlerts(report);

      const summary = [
        `diff1(Casdoor手工)=${report.diff1.length}`,
        `diff2(outbox积压)=${report.diff2.length}`,
        `diff3(镜像滞后)=${report.diff3.length}`,
        `backlog=${report.backlog.total}`,
      ].join(' | ');

      console.log(`[drift] 对账完成: ${summary}`);

      if (alerts.length > 0) {
        await notifyWecom(
          '⚠️ drift 三向对账告警',
          `${alerts.join('\n')}\n\n**汇总**: ${summary}`,
        ).catch(() => {});
      } else {
        console.log('[drift] ✅ 三向对账全通过');
      }

      return { status: 'ok', message: summary };
    } catch (e) {
      console.error('[drift] 对账异常:', (e as Error).message);
      return { status: 'error', message: (e as Error).message };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
