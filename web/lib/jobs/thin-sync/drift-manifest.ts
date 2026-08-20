// web/lib/jobs/thin-sync/drift-manifest.ts
// Drift 三向对账 job（spec §4.5 / Task 12）：
//   每日跑一次，产出 diff1/diff2/diff3 报告 → 告警。
//   spec: drift 三向对账（每日 job）：diff1/diff2/diff3 语义见组件 §4.5。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { POSTGREST_URL, INSFORGE_API_KEY } from '../env';
import { runningTasks } from '../state';
import { runDriftReport, assessAlerts, canFlipToAuto } from '../../sync/drift';
import { syncScopePacks } from '../../sync/scope-packs';

const PG_H = (): Record<string, string> => ({
  apikey: INSFORGE_API_KEY!,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
});

/**
 * Review 修复（M12/M13）：drift 从「只告警」升级为「告警 + 收敛」：
 *   diff1（Casdoor 手工配置）→ outbox 清空后翻转 casdoor_writer=manual（防 auto 路径橡皮擦）
 *   diff3（镜像滞后）→ 以 Casdoor 为真相源回写 org_users.role_codes + casdoor_synced_at
 */
async function applyRemediations(report: Awaited<ReturnType<typeof runDriftReport>>): Promise<{
  flipped: number; mirrored: number;
}> {
  let flipped = 0;
  let mirrored = 0;

  // diff1：Casdoor 有配置但镜像不一致（非 manual）→ 保护性翻转 manual
  for (const item of report.diff1) {
    // 竞态防护：outbox 有未完成项时不翻转（spec §4.5）
    if (!(await canFlipToAuto(item.wecom_id))) continue;
    await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(item.wecom_id)}`, {
      method: 'PATCH',
      headers: PG_H(),
      body: JSON.stringify({
        casdoor_writer: 'manual',
        casdoor_synced_at: new Date().toISOString(),
      }),
    }).then((r) => { if (r.ok) flipped++; }).catch(() => {});
  }

  // diff3：镜像滞后 → Casdoor 为真相源，回写镜像
  for (const item of report.diff3) {
    await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(item.wecom_id)}`, {
      method: 'PATCH',
      headers: PG_H(),
      body: JSON.stringify({
        role_codes: item.casdoor_roles ?? [],
        casdoor_synced_at: new Date().toISOString(),
      }),
    }).then((r) => { if (r.ok) mirrored++; }).catch(() => {});
  }

  return { flipped, mirrored };
}

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

      // M12/M13：告警之外执行收敛（翻转 manual + 回写镜像）
      const { flipped, mirrored } = await applyRemediations(report);

      // 范围包同步（2026-08-19 能力页=真相源）：dim_branch 区域 → maps 投影收敛，随 drift 每日跑
      const packs = await syncScopePacks();
      if (!packs.ok) console.error('[drift] 范围包同步失败:', packs.error);

      const summary = [
        `diff1(Casdoor手工)=${report.diff1.length}`,
        `diff2(outbox积压)=${report.diff2.length}`,
        `diff3(镜像滞后)=${report.diff3.length}`,
        `backlog=${report.backlog.total}`,
        `flipped_manual=${flipped}`,
        `mirror_writeback=${mirrored}`,
        `scope_packs=${packs.ok ? `ok(add ${packs.addedRows}/del ${packs.removedRows}${packs.skippedManual.length ? `, manual ${packs.skippedManual.length}` : ''})` : `FAIL:${packs.error}`}`,
      ].join(' | ');

      // 范围包同步产出新包（曾致登录 503 的缺包场景）→ 告警提醒复盘
      if (packs.addedPacks.length > 0) {
        await notifyWecom(
          '🔔 范围包已补齐（能力页真相源）',
          `dim_branch 新区域已同步为 maps 包：${packs.addedPacks.join('、')}`,
        ).catch(() => {});
      }

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
