// web/lib/jobs/registry.ts
// Job 注册表（P1）：固定清单 job 全部在此登记（JOBS 数组，宿主按 manifest.schedule 注册 cron）。
// 动态采集任务（collect_tasks 每行一个 manifest）不在此列——宿主查询后经 collectManifest(task) 工厂逐个注册。
// 新 job = jobs/<id>/manifest.ts + 此处追加 1 行；共享类型只经 contracts 消费（依赖方向铁律 §4.4）。
import type { JobManifest } from '../contracts';
import { carryDimsManifest } from './carry-dims/manifest';
import { collectManifest } from './collect/manifest';
import { contactSyncManifest } from './contact-sync/manifest';
import { dimCustomerManifest } from './dim-customer/manifest';
import { monitorManifests } from './monitor/manifest';
import { qaFullManifest } from './qa/manifest';
import { dailyReconcileManifest, sourceReconcileManifest } from './reconcile/manifest';
import { reconcileGroupsManifest } from './reconcile-groups/manifest';
import { reconcileCatalogManifest } from './reconcile-catalog/manifest';
import { scheduledReportsManifest } from './scheduled-reports/manifest';
import { targetCloseManifest } from './target-close/manifest';
// Review 修复（M16）：此前 thin-sync / drift / perm-shadow / push-contract 四个 manifest
// 已实现但未登记进 JOBS → 调度器从不注册，薄同步/对账/契约测试/权限 shadow 全部不跑。
import { thinSyncManifest } from './thin-sync/manifest';
import { driftReportManifest } from './thin-sync/drift-manifest';
import { permShadowManifest } from './perm-shadow/manifest';
import { pushContractManifest } from './push-contract/manifest';
import { pushTtlCleanupManifest } from './push-ttl-cleanup/manifest';

export { collectManifest };

export const JOBS: JobManifest[] = [
  contactSyncManifest,
  carryDimsManifest,
  dimCustomerManifest,
  dailyReconcileManifest,
  sourceReconcileManifest,
  targetCloseManifest,
  qaFullManifest,
  scheduledReportsManifest,
  thinSyncManifest,
  driftReportManifest,
  permShadowManifest,
  pushContractManifest,
  pushTtlCleanupManifest,
  reconcileGroupsManifest,
  reconcileCatalogManifest,
  ...monitorManifests,
];
