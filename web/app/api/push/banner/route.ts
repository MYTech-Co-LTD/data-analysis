// web/app/api/push/banner/route.ts
// 横幅 GET 路由（架构 §7.4 横幅渲染）：验签 + d=北京今日 → 缓存命中返回 PNG，否则 sharp 现场渲染。
// 企微无会话抓图，URL 带 HMAC 签名；B2：值已嵌入 URL，本路由纯渲染不查库。
import { NextRequest, NextResponse } from 'next/server';
import { verifyBanner, renderBannerPng, beijingToday, type BannerParams } from '@/lib/push/banner';

export async function GET(req: NextRequest) {
  // new URL(req.url) 与 req.nextUrl.searchParams 等价，但对普通 Request/NextRequest 都兼容（测试友好）
  const sp = new URL(req.url).searchParams;
  const p: BannerParams = {
    d: sp.get('d') ?? '',
    t: sp.get('t') ?? '',
    sale: sp.get('sale') ?? '',
    rate: sp.get('rate') ?? '',
  };
  const sig = sp.get('sig') ?? '';
  if (!verifyBanner(p, sig)) {
    return new NextResponse('invalid signature', { status: 403 });
  }
  // 只渲染今日横幅：签名已绑定 d，但防回放过期数据（昨日数值配今日卡片）
  if (p.d !== beijingToday()) {
    return new NextResponse('stale banner', { status: 404 });
  }
  if (!p.sale || !p.rate) {
    return new NextResponse('missing data', { status: 400 });
  }
  try {
    const png = await renderBannerPng(p);
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    console.error('[push/banner] 渲染失败:', (e as Error).message);
    return new NextResponse('render failed', { status: 500 });
  }
}
