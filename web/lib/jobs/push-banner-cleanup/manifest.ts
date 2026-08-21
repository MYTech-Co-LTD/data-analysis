// web/lib/jobs/push-banner-cleanup/manifest.ts
// 报表横幅对象 TTL 清理（架构 §7.4 2026-08-21）：push-assets/banner/ 对象存 7 天，
// 每日 04:17（Asia/Shanghai，避开 04:00 对账高峰与 push-ttl 03:47）列前缀删过期。
// 模式复用 push-ttl-cleanup：tryAcquireLock + notifyWecom；无 DB 元数据表（对象时间戳即判断）。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { createBannerStorage, BANNER_PREFIX } from '../../push/banner-storage';
import { runningTasks } from '../state';

const JOB_KEY = '__push_banner_cleanup';
const TTL_MS = 7 * 24 * 3600 * 1000;

export const pushBannerCleanupManifest: JobManifest = {
  id: JOB_KEY,
  schedule: '17 4 * * *',
  run: async (): Promise<JobResult> => {
    if (!tryAcquireLock(runningTasks, JOB_KEY, '报表横幅对象 TTL 清理')) {
      return { status: 'skipped' };
    }
    const storage = createBannerStorage();
    if (!storage) {
      runningTasks.delete(JOB_KEY);
      return { status: 'skipped', message: 'banner 存储未配置' };
    }
    try {
      const items = await storage.list(BANNER_PREFIX);
      const now = Date.now();
      let deleted = 0;
      for (const it of items) {
        if (now - it.lastModified.getTime() > TTL_MS) {
          await storage.del(it.key);
          deleted += 1;
        }
      }
      const message = `banner 对象清理: 删除 ${deleted} / 共 ${items.length}`;
      console.log(`[push-banner-cleanup] ${message}`);
      if (deleted > 500) {
        await notifyWecom('🧹 报表横幅对象清理量异常', message).catch(() => {});
      }
      return { status: 'ok', message, detail: { deleted, total: items.length } };
    } catch (e) {
      const msg = (e as Error).message;
      console.error('[push-banner-cleanup] 清理异常:', msg);
      await notifyWecom('❌ 报表横幅对象清理失败', msg).catch(() => {});
      return { status: 'error', message: msg };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
