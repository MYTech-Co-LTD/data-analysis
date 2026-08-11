// web/lib/scheduler.ts
// 定时采集调度器（薄宿主，P1 拆分后）。
// 保留：instrumentation 自启（globalThis.__schedulerState 单例）+ 固定清单/动态采集任务按 manifest.schedule 注册 cron。
// 业务搬入 web/lib/jobs/*（collect/reconcile/carry-dims/dim-customer/contact-sync/target-close/monitor/qa）；
// 防重入锁 + 水位线机制随 job 搬迁（runningTasks/tryAcquireLock + params.watermark 仍原样工作）。
// 行为零回归：采集/对账/告警/carry-dims 逻辑未动，只改代码组织。
import cron from 'node-cron';
import { createClient } from '@insforge/sdk';
import type { JobContext, JobManifest } from './contracts';
import { scheduledJobs, schedulerState } from './jobs/state';
import { collectManifest, JOBS } from './jobs/registry';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// P1：job run(ctx) 的函数体为原样搬迁、自含 env/client/锁，尚不消费宿主注入的 ctx；
// ctx 契约字段 P1 冻结后由后续迭代真实注入。此处占位避免悬空契约。
const hostCtx = {} as JobContext;

/**
 * 按 manifest.schedule 注册 cron（固定清单 + 动态 collect_tasks 共用）。
 * 与原 registerTask / 各 register*Job 行为一致：已注册先取消、cron 无效跳过、Asia/Shanghai 时区。
 */
function registerManifest(manifest: JobManifest): void {
  const schedule = manifest.schedule;
  if (!schedule) return; // 无 schedule = 手动/事件触发，不注册 cron

  // 如果已注册，先取消
  if (scheduledJobs.has(manifest.id)) {
    scheduledJobs.get(manifest.id)?.stop();
    scheduledJobs.delete(manifest.id);
  }

  // 校验 cron 表达式
  if (!cron.validate(schedule)) {
    console.warn(`[scheduler] job ${manifest.id} 的 cron 表达式无效: ${schedule}`);
    return;
  }

  console.log(`[scheduler] 注册任务: ${manifest.id} (${schedule})`);

  // 注册 cron 任务
  const job = cron.schedule(schedule, async () => {
    console.log(`[scheduler] ⏰ 定时触发: ${manifest.id}`);
    await manifest.run(hostCtx);
  }, {
    timezone: 'Asia/Shanghai'
  });

  scheduledJobs.set(manifest.id, job);
}

/**
 * 初始化调度器：注册固定清单 job + 读取所有启用的采集任务，注册 cron（自动初始化）
 */
export async function ensureSchedulerInitialized(): Promise<boolean> {
  if (schedulerState.initialized) return true;

  console.log('[scheduler] 初始化定时采集调度器...');

  // 固定清单 job（通讯录/维表/对账/QA/监控/目标固化）——先注册，不依赖采集任务查询结果/是否为空
  for (const manifest of JOBS) {
    registerManifest(manifest);
  }

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    // 查询所有启用的采集任务
    const { data: tasks, error } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, function_slug, schedule_cron, params, enabled')
      .eq('enabled', true);

    if (error) {
      console.error('[scheduler] 查询任务失败:', error);
      return false;
    }

    if (!tasks || tasks.length === 0) {
      console.log('[scheduler] 无启用的采集任务');
      schedulerState.initialized = true;
      return true;
    }

    console.log(`[scheduler] 发现 ${tasks.length} 个启用的任务`);

    for (const task of tasks) {
      registerManifest(collectManifest(task));
    }

    schedulerState.initialized = true;
    console.log('[scheduler] 调度器初始化完成');
    return true;
  } catch (err: unknown) {
    console.error('[scheduler] 初始化异常:', (err as Error).message);
    return false;
  }
}

/**
 * 重新加载调度器（任务配置变更后调用）
 */
export async function reloadScheduler() {
  console.log('[scheduler] 重新加载调度器...');

  // 停止所有任务
  for (const [id, job] of scheduledJobs) {
    job.stop();
    console.log(`[scheduler] 停止任务: ${id}`);
  }
  scheduledJobs.clear();

  // 重置初始化标记，重新初始化
  schedulerState.initialized = false;
  await ensureSchedulerInitialized();
}

/**
 * 获取已注册的任务列表
 */
export function getScheduledTasks() {
  return Array.from(scheduledJobs.entries()).map(([id, job]) => ({
    task_id: id,
    running: job.getStatus() === 'scheduled'
  }));
}
