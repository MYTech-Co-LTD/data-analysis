// web/lib/jobs/reconcile-catalog/manifest.ts
// W1 Task6：catalog 每日对账 cron（03:47——错开 02:00 明细对账 / 03:17 门店树 / 03:30 perm-shadow /
// 03:37 reconcile-groups 窗口）。链路 = ①resource 注册自愈（syncResources 差集只插，Task 4）
// → ②permissions vs catalog 对账（web/lib/reconcile-catalog.ts，Task 5 语义同源；同步失败通道
// 喂 C-sync-failed 红，L2 不静默）→ ③红 > 0 发企微告警（collect_fail 同款通道）。
// 与部署钩子（GHA catalog job）分工：部署时点 SSH 门禁走 scripts/reconcile-catalog.mjs（CI 版），
// 本 job 承担日终观测 + 自愈 + 告警；辅助页 /admin/capabilities 查看时在线重算（查看即自愈）。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { syncResources } from '../../sync/resource-sync';
import { classifyCatalogReconcile, fetchCasdoorPermissions } from '../../reconcile-catalog';
import { runningTasks } from '../state';

export const reconcileCatalogManifest: JobManifest = {
  id: '__reconcile_catalog',
  schedule: '47 3 * * *', // 每日 03:47（Task6 cron 对账入口；见文件头窗口错峰说明）
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__reconcile_catalog';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      const org = process.env.CASDOOR_ORG || 'shanhai';

      // ① resource 注册自愈（add-resource 幂等只补缺；deprecated 不注册）
      const sync = await syncResources(org);

      // ② 对账（真授权语义 F11：permission.resources；失败通道喂红区）
      const permissions = await fetchCasdoorPermissions();
      const d = classifyCatalogReconcile({ permissions, syncFailures: sync.failed });

      // ③ 红 > 0 企微告警（不阻断；collect_logs 有 task_id FK 不落虚拟行，直发 notifyWecom——Task 10 同款）
      if (d.red.length > 0) {
        const lines = d.red.slice(0, 10).map((r) =>
          `- [${r.kind}] ${r.key} ← ${r.holders.join(', ')}${r.kind === 'C-sync-failed' ? `（${r.error}）` : ''}`,
        );
        await notifyWecom(
          '🔴 catalog 对账红（W1 Task6）',
          `**注册**: added=${sync.added.length} failed=${sync.failed.length}\n**红**: ${d.red.length} / 提示 ${d.minor.length} / 通配持有者 ${d.wildcardHolders.length}\n${lines.join('\n')}${d.red.length > 10 ? '\n…' : ''}`,
        );
      }
      console.log(`[reconcile-catalog] sync added=${sync.added.length} failed=${sync.failed.length} → red=${d.red.length} minor=${d.minor.length} wildcards=${d.wildcardHolders.length}`);

      return {
        status: 'ok',
        message: `red=${d.red.length} minor=${d.minor.length} syncFailed=${sync.failed.length} added=${sync.added.length}`,
        detail: {
          summary: { red: d.red.length, minor: d.minor.length, wildcardHolders: d.wildcardHolders.length },
          sync: { added: sync.added, failed: sync.failed, skipped: sync.skippedExisting.length },
          red: d.red, wildcardHolders: d.wildcardHolders,
        },
      };
    } finally {
      runningTasks.delete('__reconcile_catalog');
    }
  },
};
