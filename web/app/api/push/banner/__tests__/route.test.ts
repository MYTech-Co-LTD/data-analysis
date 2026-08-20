// web/app/api/push/banner/__tests__/route.test.ts
// 验签 + d 校验 → 403/404/400/200 四态钉死；renderBannerPng mock 掉避免真实 sharp。
// 注：GET 在 beforeEach 内 doMock 注册后再 import，确保 route 用的是 mock 版 renderBannerPng
//   （顶层 import 会在 doMock 前加载真实模块，mock 不生效）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signBanner, beijingToday } from '@/lib/push/banner';

vi.stubEnv('JWT_SECRET', 'test-secret-0123456789abcdef');

const mkParams = (over: Record<string, string> = {}) => {
  const p = { d: beijingToday(), t: '123', sale: '¥128,500', rate: '86.4%' };
  return { ...p, ...over };
};

let GET: typeof import('../route').GET;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@/lib/push/banner', async () => {
    const actual = await import('@/lib/push/banner');
    return {
      ...actual,
      renderBannerPng: vi.fn(async () => Buffer.from('PNGDATA')),
    };
  });
  const mod = await import('../route');
  GET = mod.GET;
});

describe('GET /api/push/banner', () => {
  it('签名有效 + 今日 → 200 image/png', async () => {
    const p = mkParams();
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new NextRequest(url));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('image/png');
  });
  it('签名无效 → 403', async () => {
    const p = mkParams();
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig: 'bad' }).toString()}`);
    const resp = await GET(new NextRequest(url));
    expect(resp.status).toBe(403);
  });
  it('d 非北京今日 → 404（防回放过期数据）', async () => {
    const p = mkParams({ d: '2026-08-19' });
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new NextRequest(url));
    expect(resp.status).toBe(404);
  });
  it('缺 sale/rate → 400', async () => {
    const p = mkParams({ sale: '', rate: '' });
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new NextRequest(url));
    expect(resp.status).toBe(400);
  });
});
