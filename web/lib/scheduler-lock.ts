// web/lib/scheduler-lock.ts
// 采集任务防重入锁工具：runningTasks 从 Set<string> 升级为 Map<string, number>（taskId → 加锁时刻），
// 支持「陈旧锁（>30min）自动释放」——任务挂起/崩溃致 finally 未执行、锁永久残留时，
// 超过 LOCK_STALE_MS 后自动清锁；只跳本次、不做并发重入（避免旧 promise 仍存活时双跑），
// 等下次 cron 自然恢复，不依赖重启 web。
//
// 独立成无依赖模块：单测可直测纯逻辑，不拖入 scheduler.ts 的重依赖（collect/qa/node-cron/环境变量）。

export const LOCK_STALE_MS = 30 * 60 * 1000;

export type RunningTasks = Map<string, number>;

// 纯函数：锁是否已陈旧（加锁时刻距今超过 LOCK_STALE_MS 视为残留；恰好等于不算）
export function isLockStale(acquiredAt: number, now: number = Date.now()): boolean {
  return now - acquiredAt > LOCK_STALE_MS;
}

/**
 * 尝试获取任务锁（防重入）。
 * - 无锁 → 加锁并返回 true（本次可执行）
 * - 有锁且新鲜 → 返回 false（跳过本次；opts.logSkip=true 时打印告警）
 * - 有锁且陈旧（> LOCK_STALE_MS）→ 清锁并返回 false（本次跳过，等下次 cron 恢复；不做并发重入）
 */
export function tryAcquireLock(
  running: RunningTasks,
  key: string,
  label: string,
  opts: { logSkip?: boolean } = {},
): boolean {
  if (running.has(key)) {
    const start = running.get(key)!;
    if (isLockStale(start)) {
      console.warn(`[scheduler] ${label} 锁陈旧(${Date.now() - start}ms)，释放，本次跳过`);
      running.delete(key);
    } else if (opts.logSkip) {
      console.warn(`[scheduler] ${label} 已在运行，跳过本次触发`);
    }
    return false;
  }
  running.set(key, Date.now());
  return true;
}

export function releaseLock(running: RunningTasks, key: string): void {
  running.delete(key);
}
