// web/lib/jobs/push-ttl-cleanup/manifest.ts
// 推送审计 TTL 清理 job（生产接线 清理项 / 迁移 189 配套）：
//   push_trigger_payloads 表注释承诺 7 天 TTL，但此前无执行者 → 无限增长。
//   每日 03:47（Asia/Shanghai，避开 04 点对账高峰）调 cleanup_push_audit(7) RPC
//   （SECURITY DEFINER，下限守卫 >=7 天，anon 无 DELETE 直权）。
// 依赖方向铁律：仅消费 contracts（JobManifest/JobResult）、env、scheduler-lock、notifyWecom。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

const JOB_KEY = '__push_ttl_cleanup';
const TTL_DAYS = 7;

export const pushTtlCleanupManifest: JobManifest = {
  id: '__push_ttl_cleanup',
  // 每日 03:47 清理（与通讯录 03:17 / drift 04:23 错开）
  schedule: '47 3 * * *',
  run: async (): Promise<JobResult> => {
    if (!tryAcquireLock(runningTasks, JOB_KEY, 'push 审计 TTL 清理')) {
      return { status: 'skipped' };
    }

    try {
      console.log(`[push-ttl] 开始清理（TTL=${TTL_DAYS} 天）`);

      const r = await fetch(`${POSTGREST_URL}/rpc/cleanup_push_audit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: INSFORGE_API_KEY!,
          Authorization: `Bearer ${INSFORGE_API_KEY}`,
        },
        body: JSON.stringify({ p_days: TTL_DAYS }),
      });

      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`cleanup_push_audit RPC ${r.status}: ${detail}`);
      }
      const rows = (await r.json()) as Array<{
        payloads_deleted: number | string;
        logs_deleted: number | string;
      }>;
      const deleted = Number(rows[0]?.payloads_deleted ?? 0);
      const logs = Number(rows[0]?.logs_deleted ?? 0);

      const message = `payloads_deleted=${deleted} | logs_deleted=${logs}`;
      console.log(`[push-ttl] ✅ 清理完成: ${message}`);

      // 大量删除（>5 万）才告警知会（正常每日少量静默）
      if (deleted + logs > 50_000) {
        await notifyWecom('🧹 push 审计 TTL 清理量异常', message).catch(() => {});
      }

      return { status: 'ok', message, detail: { payloadsDeleted: deleted, logsDeleted: logs } };
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[push-ttl] 清理异常:', msg);
      await notifyWecom('❌ push 审计 TTL 清理失败', msg).catch(() => {});
      return { status: 'error', message: msg };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
