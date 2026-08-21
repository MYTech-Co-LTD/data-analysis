// 横幅 GET 路由（架构 §7.4 2026-08-21 S3 读回）：(k,e,sig) 三参验签 + 未过期 → storage.get(bannerKey(k)) 读 PNG。
// 状态码分工（裁定 2026-08-21）：参数畸形/缺失 → 400；签名失败/过期 → 403；对象不存在 → 404；存储未配置/读失败 → 500。
// 私有缓存：RLS 数据防 CDN 缓存跨人复用 → Cache-Control: private（方案 C 的 public 已废弃）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import { signBannerObject, bannerExpiresAt } from '@/lib/push/banner-report-resolve';

vi.stubEnv('JWT_SECRET', 'test-secret-0123456789abcdef');

const { storageMock } = vi.hoisted(() => ({ storageMock: { put: vi.fn(), get: vi.fn(), list: vi.fn(), del: vi.fn() } }));
vi.mock('@/lib/push/banner-storage', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/push/banner-storage')>();
  return { ...mod, createBannerStorage: vi.fn(() => storageMock) };
});

const req = (q: string) => new NextRequest(`http://localhost/api/push/banner?${q}`);

describe('GET /api/push/banner（S3 读回）', () => {
  beforeEach(() => {
    storageMock.get.mockReset();
  });

  it('合法签名 + 未过期 → 200 image/png 私有缓存，且查的对象键正确', async () => {
    const k = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const e = bannerExpiresAt(Date.now());
    const sig = signBannerObject(k, e);
    storageMock.get.mockResolvedValue(Buffer.from('PNGDATA'));
    const res = await GET(req(`k=${k}&e=${e}&sig=${encodeURIComponent(sig)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
    expect(storageMock.get).toHaveBeenCalledWith('push-assets/banner/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png');
  });

  it('篡改 sig → 403 不查 S3', async () => {
    const res = await GET(req(`k=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&e=${bannerExpiresAt(Date.now())}&sig=bad`));
    expect(res.status).toBe(403);
    expect(storageMock.get).not.toHaveBeenCalled();
  });

  it('过期（now > e）→ 403', async () => {
    const k = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const e = Math.floor(Date.now() / 1000) - 100; // 已过期
    const sig = signBannerObject(k, e);
    const res = await GET(req(`k=${k}&e=${e}&sig=${encodeURIComponent(sig)}`));
    expect(res.status).toBe(403);
  });

  it('对象不存在 → 404', async () => {
    const k = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const e = bannerExpiresAt(Date.now());
    const sig = signBannerObject(k, e);
    storageMock.get.mockResolvedValue(null);
    const res = await GET(req(`k=${k}&e=${e}&sig=${encodeURIComponent(sig)}`));
    expect(res.status).toBe(404);
  });

  it('e 非数字 → 400（参数畸形，裁定 2026-08-21）', async () => {
    const k = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sig = signBannerObject(k, 1756000000);
    const res = await GET(req(`k=${k}&e=abc&sig=${encodeURIComponent(sig)}`));
    expect(res.status).toBe(400);
    expect(storageMock.get).not.toHaveBeenCalled();
  });

  it('缺 e 参数 → 400（参数缺失）', async () => {
    const k = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const res = await GET(req(`k=${k}&sig=x`));
    expect(res.status).toBe(400);
  });
});
