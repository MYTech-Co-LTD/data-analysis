// web/lib/__tests__/scheduler-lock.test.ts
// scheduler 防重入锁（Set→Map + 陈旧锁自动释放）单测。
// scheduler.ts 导入链过重（collect/qa/node-cron/环境变量），锁逻辑已抽到无依赖的
// scheduler-lock.ts，这里直测其纯逻辑：mock running Map
// （陈旧 30min 前 → 释放+跳过；新鲜 → 正常跳过）。
import { describe, it, expect, vi } from 'vitest';
import { tryAcquireLock, releaseLock, isLockStale, LOCK_STALE_MS } from '../scheduler-lock';

describe('scheduler 防重入锁', () => {
  it('无锁时：加锁并返回 true（本次可执行）', () => {
    const running = new Map<string, number>();
    const ok = tryAcquireLock(running, 'task-1', '任务 A');
    expect(ok).toBe(true);
    expect(running.has('task-1')).toBe(true);
    expect(typeof running.get('task-1')).toBe('number');
  });

  it('有锁且新鲜：返回 false（跳过本次），锁保留不清', () => {
    const running = new Map<string, number>([['task-1', Date.now()]]);
    const ok = tryAcquireLock(running, 'task-1', '任务 A');
    expect(ok).toBe(false);
    expect(running.has('task-1')).toBe(true); // 新鲜锁不清，仍防重入
  });

  it('有锁且陈旧（30min 前）：释放锁 + 返回 false（本次跳过）', () => {
    const running = new Map<string, number>([['task-1', Date.now() - LOCK_STALE_MS - 1000]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = tryAcquireLock(running, 'task-1', '任务 A');
    expect(ok).toBe(false);
    expect(running.has('task-1')).toBe(false); // 陈旧锁被释放
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('锁陈旧'));
    warn.mockRestore();
  });

  it('陈旧锁释放后，下次 cron 可正常加锁（自愈，不依赖重启）', () => {
    const running = new Map<string, number>([['task-1', Date.now() - LOCK_STALE_MS - 5000]]);
    expect(tryAcquireLock(running, 'task-1', '任务 A')).toBe(false); // 本次跳过
    expect(running.has('task-1')).toBe(false); // 锁已清
    // 下一 tick：无锁 → 可执行
    const ok = tryAcquireLock(running, 'task-1', '任务 A');
    expect(ok).toBe(true);
    expect(typeof running.get('task-1')).toBe('number');
  });

  it('陈旧锁只清锁跳本次，不做并发重入（返回 false 而非 true）', () => {
    // 模拟旧 promise 仍存活场景：陈旧锁 → 本次必须返回 false，不能并发双跑
    const running = new Map<string, number>([['task-1', Date.now() - LOCK_STALE_MS - 60_000]]);
    const ok = tryAcquireLock(running, 'task-1', '任务 A');
    expect(ok).toBe(false);
    expect(running.has('task-1')).toBe(false);
  });

  it('isLockStale 边界：恰好 = LOCK_STALE_MS 不算陈旧（> 才算）', () => {
    const now = 1_000_000_000;
    expect(isLockStale(now - LOCK_STALE_MS, now)).toBe(false);
    expect(isLockStale(now - LOCK_STALE_MS - 1, now)).toBe(true);
  });

  it('releaseLock 删除锁', () => {
    const running = new Map<string, number>([['task-1', Date.now()]]);
    releaseLock(running, 'task-1');
    expect(running.has('task-1')).toBe(false);
  });
});
