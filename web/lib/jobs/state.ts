// web/lib/jobs/state.ts
// 调度器共享状态：用 globalThis 持有，跨 chunk 单例（从原 scheduler.ts 搬移，键名 __schedulerState 不变）。
// Next.js 把 instrumentation.ts 与 route handler 打包进不同 chunk，各自有独立模块作用域，
// 模块级变量不共享 → 会出现「两个 scheduler 实例」导致同一 cron 双触发、防重入锁也跨实例失效。
// 统一挂到 globalThis（同进程同 V8 global）确保唯一实例。
import type { ScheduledTask } from 'node-cron';

export type SchedulerState = {
  jobs: Map<string, ScheduledTask>;
  // 防重入锁：taskId → 加锁时刻（Date.now()）。Set→Map 以便陈旧锁（>30min）自动释放。
  running: Map<string, number>;
  initialized: boolean;
};
const globalForScheduler = globalThis as unknown as { __schedulerState?: SchedulerState };
const state: SchedulerState = (globalForScheduler.__schedulerState ??= {
  jobs: new Map<string, ScheduledTask>(),
  running: new Map<string, number>(),
  initialized: false,
});

// 引用共享状态：Map / Set 按引用共享，方法调用直接作用于全局实例；
// initialized 为布尔值（按值），必须经 schedulerState.initialized 读写才能跨 chunk 同步。
export const scheduledJobs = state.jobs;
export const runningTasks = state.running;
export const schedulerState = state;
