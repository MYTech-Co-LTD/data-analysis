import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobResult } from '../../contracts';
import { pushBannerCleanupManifest } from '../push-banner-cleanup/manifest';

// JobManifest.run 接口签名带 ctx 参数；本 job 零参实现（与仓库全部 manifest 一致），
// 测试调用点需显式收窄为零参签名，否则 tsc 报 Expected 1 arguments。
const runCleanup = pushBannerCleanupManifest.run as () => Promise<JobResult>;

const { storageMock } = vi.hoisted(() => ({
  storageMock: { put: vi.fn(), get: vi.fn(), list: vi.fn(), del: vi.fn() },
}));
// 注：banner-storage 实际位于 lib/push/banner-storage（Task 2 产物）；manifest 从
// lib/jobs/push-banner-cleanup/ 引 ../../push/banner-storage，此处 mock 路径须与其一致，
// 否则 vi.mock 解析到不存在的 lib/jobs/push/banner-storage 而静默失效。
vi.mock('../../push/banner-storage', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../push/banner-storage')>();
  return { ...mod, createBannerStorage: vi.fn(() => storageMock) };
});

const OLD = new Date(Date.now() - 8 * 24 * 3600 * 1000); // 8 天前
const FRESH = new Date(Date.now() - 3600 * 1000);       // 1 小时前

describe('push-banner-cleanup manifest', () => {
  beforeEach(() => {
    storageMock.put.mockReset();
    storageMock.get.mockReset();
    storageMock.list.mockReset();
    storageMock.del.mockReset();
  });

  it('id/schedule 正确', () => {
    expect(pushBannerCleanupManifest.id).toBe('__push_banner_cleanup');
    expect(pushBannerCleanupManifest.schedule).toBe('17 4 * * *');
  });

  it('删过期对象、留新对象', async () => {
    storageMock.list.mockResolvedValue([
      { key: 'push-assets/banner/old1.png', lastModified: OLD },
      { key: 'push-assets/banner/old2.png', lastModified: OLD },
      { key: 'push-assets/banner/new1.png', lastModified: FRESH },
    ]);
    const r = await runCleanup();
    expect(r.status).toBe('ok');
    expect(storageMock.del).toHaveBeenCalledTimes(2);
    expect(storageMock.del).toHaveBeenCalledWith('push-assets/banner/old1.png');
    expect(storageMock.del).toHaveBeenCalledWith('push-assets/banner/old2.png');
  });

  it('list 失败 → status error + 不 del', async () => {
    storageMock.list.mockRejectedValue(new Error('s3 down'));
    const r = await runCleanup();
    expect(r.status).toBe('error');
    expect(storageMock.del).not.toHaveBeenCalled();
  });
});
