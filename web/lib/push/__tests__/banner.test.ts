// web/lib/push/__tests__/banner.test.ts
// Task 1 横幅渲染库测试（brief Step 1）：签名/验签、URL 组装、SVG 渲染、注入助手、缓存逻辑。
// 缓存测试采用 brief 明示容许偏差：顶层 vi.mock('sharp')，断言命中/逐出逻辑、不实际调 sharp。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beijingToday, canonicalBanner, signBanner, verifyBanner, buildBannerUrl,
  renderBannerSvg, hasBannerPlaceholder, injectBanner, BANNER_PLACEHOLDER_URL,
} from '../banner';

// sharp 全文件 mock（缓存命中路径不实际调 sharp）
const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({
    png: () => ({ toBuffer: async () => Buffer.from('PNG') }),
  })),
}));
vi.mock('sharp', () => ({ default: sharpMock }));

vi.stubEnv('JWT_SECRET', 'test-secret-0123456789abcdef');
vi.stubEnv('PUSH_BRIDGE_BASE_URL', 'https://data.shanhaiyiguo.com/api/wecom-bridge');

const p = { d: '2026-08-20', t: '123', sale: '¥128,500', rate: '86.4%' };

describe('beijingToday 北京日界', () => {
  it('北京 00:30（UTC 昨日 16:30）取北京当日', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-19T16:30:00.000Z')); // = 北京 2026-08-20 00:30
      expect(beijingToday()).toBe('2026-08-20');
    } finally {
      vi.useRealTimers();
    }
  });
  it('北京 08:00（UTC 同日 00:00）取北京当日', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z')); // = 北京 2026-08-20 08:00
      expect(beijingToday()).toBe('2026-08-20');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hasBannerPlaceholder', () => {
  it('占位 URL → true', () => {
    expect(hasBannerPlaceholder({ card_image: { url: BANNER_PLACEHOLDER_URL } })).toBe(true);
  });
  it('其它 URL → false', () => {
    expect(hasBannerPlaceholder({ card_image: { url: 'https://x/y.png' } })).toBe(false);
  });
  it('card_json 为 null/undefined → false', () => {
    expect(hasBannerPlaceholder(null)).toBe(false);
    expect(hasBannerPlaceholder(undefined)).toBe(false);
  });
});

describe('canonicalBanner', () => {
  it('固定键序 JSON 数组（值内含分隔符无歧义）', () => {
    expect(canonicalBanner(p)).toBe(JSON.stringify([p.d, p.t, p.sale, p.rate]));
  });
});

describe('banner 签名', () => {
  it('signBanner 生成稳定签名且 verifyBanner 通过', () => {
    const sig = signBanner(p);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyBanner(p, sig)).toBe(true);
  });
  it('篡改任一参数 → 验签失败', () => {
    const sig = signBanner(p);
    expect(verifyBanner({ ...p, sale: '¥999,999' }, sig)).toBe(false);
    expect(verifyBanner({ ...p, d: '2026-08-19' }, sig)).toBe(false);
  });
  it('sig 空或长度不等 → 验签失败', () => {
    expect(verifyBanner(p, '')).toBe(false);
    expect(verifyBanner(p, 'short')).toBe(false);
  });
});

describe('banner URL 组装', () => {
  it('buildBannerUrl 从 bridge base 派生 + 含全部参数', () => {
    const url = buildBannerUrl(p);
    expect(url).toMatch(/^https:\/\/data\.shanhaiyiguo\.com\/api\/push\/banner\?/);
    const u = new URL(url);
    expect(u.searchParams.get('d')).toBe('2026-08-20');
    expect(u.searchParams.get('t')).toBe('123');
    expect(u.searchParams.get('sale')).toBe('¥128,500');
    expect(u.searchParams.get('rate')).toBe('86.4%');
    expect(u.searchParams.get('sig')).toBe(signBanner(p));
  });
});

describe('banner SVG', () => {
  it('含 sale/rate 文本 + @font-face data URI', () => {
    const svg = renderBannerSvg(p);
    expect(svg).toContain('¥128,500');
    expect(svg).toContain('86.4%');
    expect(svg).toContain('@font-face');
    expect(svg).toContain('data:application/font-otf;charset=utf-8;base64,');
  });
  it('XML 转义特殊字符（防 SVG 注入）', () => {
    const svg = renderBannerSvg({ d: '2026-08-20', t: '1', sale: '<bad>&"', rate: '1%' });
    expect(svg).not.toContain('<bad>');
    expect(svg).toContain('&lt;bad&gt;');
  });
});

describe('injectBanner（Task 2 引擎调用的助手）', () => {
  const preset = { msgtype: 'template_card', card_json: { card_image: { url: BANNER_PLACEHOLDER_URL, aspect_ratio: 2.25 } } };
  it('槽位齐 → 注入 banner_url', () => {
    const rendered: Record<string, string> = { sale_amount: '¥128,500', achievement_rate: '86.4%' };
    injectBanner(preset, rendered, 123);
    expect(rendered.banner_url).toMatch(/\/api\/push\/banner\?/);
    expect(rendered.banner_url).toContain(encodeURIComponent('¥128,500'));
  });
  it('rate 缺失 → 不注入（优雅降级）', () => {
    const rendered: Record<string, string> = { sale_amount: '¥128,500' };
    injectBanner(preset, rendered, 123);
    expect(rendered.banner_url).toBeUndefined();
  });
  it('card_image 非占位 → 不注入', () => {
    const preset2 = { msgtype: 'template_card', card_json: { card_image: { url: 'https://x/y.png' } } };
    const rendered: Record<string, string> = { sale_amount: '¥1', achievement_rate: '50%' };
    injectBanner(preset2, rendered, 1);
    expect(rendered.banner_url).toBeUndefined();
  });
  it('msgtype 非 template_card → 不注入', () => {
    const p2 = { msgtype: 'text', card_json: { card_image: { url: BANNER_PLACEHOLDER_URL } } };
    const rendered: Record<string, string> = { sale_amount: '¥1', achievement_rate: '50%' };
    injectBanner(p2, rendered, 1);
    expect(rendered.banner_url).toBeUndefined();
  });
});

describe('renderBannerPng 缓存', () => {
  beforeEach(() => {
    vi.resetModules();
    sharpMock.mockClear();
  });

  it('首次渲染调 sharp，二次命中缓存不调', async () => {
    const { renderBannerPng } = await import('../banner');
    const a = await renderBannerPng(p);
    const b = await renderBannerPng(p);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toEqual(b);
    expect(sharpMock).toHaveBeenCalledTimes(1);
  });

  it('同 (d,t) 不同 sale/rate → 不命中缓存（键纳入值字段）', async () => {
    const { renderBannerPng } = await import('../banner');
    await renderBannerPng(p); // sale=¥128,500 rate=86.4%
    await renderBannerPng({ ...p, sale: '¥999,999', rate: '72.1%' }); // 同 d/t 不同值
    expect(sharpMock).toHaveBeenCalledTimes(2);
  });

  it('TTL 过期后重建（24h）', async () => {
    vi.useFakeTimers();
    try {
      const { renderBannerPng } = await import('../banner');
      await renderBannerPng(p);
      expect(sharpMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 3600 * 1000 + 1000);
      await renderBannerPng(p);
      expect(sharpMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超上限逐出最旧（CACHE_MAX=64）', async () => {
    const { renderBannerPng } = await import('../banner');
    for (let i = 0; i < 65; i++) {
      await renderBannerPng({ ...p, t: String(i) });
    }
    expect(sharpMock).toHaveBeenCalledTimes(65);
    // 最新键 t=64 仍在缓存 → 不调 sharp
    await renderBannerPng({ ...p, t: '64' });
    expect(sharpMock).toHaveBeenCalledTimes(65);
    // 最旧键 t=0 已被逐出 → 重新渲染
    await renderBannerPng({ ...p, t: '0' });
    expect(sharpMock).toHaveBeenCalledTimes(66);
  });
});
