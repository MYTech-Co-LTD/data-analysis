// 横幅 GET 路由（架构 §7.4 2026-08-21）：验签（k,e,sig 三参）+ 未过期 → S3 GetObject 读回 PNG。
// 企微无会话抓图；值不落 URL（report_banner 已预渲染落对象存储）；私有桶经签名路由读回（防爬/防转发）。
// 状态码：参数畸形/缺失 → 400；签名失败/过期 → 403；对象不存在 → 404；存储未配置/读失败 → 500。
// 缓存头必须 private（RLS 数据防 CDN 缓存跨人复用；方案 C 的 public 已废弃）。
import { NextRequest, NextResponse } from 'next/server';
import { verifyBannerObject } from '@/lib/push/banner-report-resolve';
import { createBannerStorage, bannerKey } from '@/lib/push/banner-storage';

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const k = sp.get('k') ?? '';
  const eRaw = sp.get('e') ?? '';
  const sig = sp.get('sig') ?? '';
  const e = Number(eRaw);
  if (!k || !eRaw || !Number.isInteger(e)) {
    return new NextResponse('bad request', { status: 400 });
  }
  if (!verifyBannerObject(k, e, sig)) {
    return new NextResponse('invalid signature', { status: 403 });
  }
  if (Date.now() > e) {
    return new NextResponse('expired', { status: 403 });
  }
  const storage = createBannerStorage();
  if (!storage) {
    return new NextResponse('storage not configured', { status: 500 });
  }
  try {
    const png = await storage.get(bannerKey(k));
    if (!png) return new NextResponse('not found', { status: 404 });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (e2) {
    console.error('[push/banner] 读对象失败:', (e2 as Error).message);
    return new NextResponse('storage error', { status: 500 });
  }
}
