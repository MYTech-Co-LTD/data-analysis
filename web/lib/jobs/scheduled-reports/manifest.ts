// web/lib/jobs/scheduled-reports/manifest.ts
// 定时报表推送（U7 cutover）：替代旧 wecom-push cron，路由经 run_push 引擎。
// 旧路径：wecom-push function → 读 reports 表 → 企微 textcard 直投（已退役，代码保留）。
// 新路径：读 scheduled_reports → run_push 引擎（四守卫+Novu+bridge+降级）→ txnId 日志。
// txnId 贯穿 trigger log → Novu → bridge，全链路可追。
// rollback：重启用 wecom-push cron 即可回退旧路径（代码未删）。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_BASE, AGENT_API_KEY } from '../env';
import { runningTasks } from '../state';

// run_push 接口契约（Task 9 产出，按 spec §5.4 签名）
interface RunPushOpts {
  workflow_id: string;
  operator_id: string;
  selector: { type: string; [key: string]: unknown };
  broadcast_perm?: boolean;
  deliver?: boolean;
  template_key?: string | null;
  query_intent?: unknown | null;
  cron_job_id?: string | null;
}

interface RunPushResult {
  txnId: string;
  groups: number;
  skipped: string[];
  fallback?: boolean;
  fallbackReason?: string;
}

/**
 * 调 web /api/push 路由到 run_push 引擎。
 * 与 agent-query push_report 模式同路径，保证投递口径一致。
 */
async function callRunPush(opts: RunPushOpts): Promise<RunPushResult> {
  const webBase = process.env.WEB_BASE_URL || 'http://localhost:3000';
  const resp = await fetch(`${webBase}/api/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENT_API_KEY}`,
    },
    body: JSON.stringify(opts),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`run_push failed: ${resp.status} ${detail}`);
  }
  return resp.json();
}

export const scheduledReportsManifest: JobManifest = {
  id: '__scheduled_reports',
  // 每小时整点检查（具体推送时间由 scheduled_reports.cron_expression 控制，
  // 此 job 负责扫描到期的报表并触发推送）
  schedule: '0 * * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__scheduled_reports';
    if (!tryAcquireLock(runningTasks, JOB_KEY, '定时报表推送', { logSkip: true })) {
      return { status: 'skipped' };
    }

    try {
      console.log('[scheduler] 定时报表推送扫描开始');

      // 查询活跃的定时报表（经 PostgREST RPC）
      const postgrestUrl = process.env.POSTGREST_URL || 'http://postgrest:3000';
      const jwtResp = await fetch(`${postgrestUrl}/rpc/get_due_scheduled_reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (!jwtResp.ok) {
        console.warn('[scheduled-reports] 查询到期报表失败:', jwtResp.status);
        return { status: 'error', message: `查询失败: ${jwtResp.status}` };
      }

      const reports = await jwtResp.json().catch(() => []);
      if (!Array.isArray(reports) || reports.length === 0) {
        console.log('[scheduled-reports] 无到期报表');
        return { status: 'ok', message: '无到期报表' };
      }

      console.log(`[scheduled-reports] 发现 ${reports.length} 个到期报表`);
      const results: Array<{ id: string; txnId?: string; error?: string }> = [];

      for (const report of reports) {
        try {
          const pushResult = await callRunPush({
            workflow_id: `scheduled:${report.id}`,
            operator_id: report.owner || 'system:cron',
            selector: report.selector || { type: 'all' },
            template_key: report.template_key || null,
            query_intent: report.query_intent || null,
            broadcast_perm: false,
            deliver: true,
            cron_job_id: report.cron_job_id || null,
          });

          // txnId 可追：trigger log → Novu → bridge 共享此 ID
          console.log(
            `[scheduled-reports] ${report.id} → txnId=${pushResult.txnId} ` +
            `groups=${pushResult.groups} skipped=${pushResult.skipped.length}` +
            (pushResult.fallback ? ' [FALLBACK]' : ''),
          );
          results.push({ id: report.id, txnId: pushResult.txnId });
        } catch (e: unknown) {
          console.error(`[scheduled-reports] ${report.id} 推送失败:`, (e as Error).message);
          results.push({ id: report.id, error: (e as Error).message });
        }
      }

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        return {
          status: 'error',
          message: `${failed.length}/${results.length} 个报表推送失败`,
          detail: results,
        };
      }

      return {
        status: 'ok',
        message: `${results.length} 个报表推送成功`,
        detail: results,
      };
    } catch (e: unknown) {
      console.error('[scheduled-reports] 异常:', (e as Error).message);
      return { status: 'error', message: (e as Error).message };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
