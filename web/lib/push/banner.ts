// web/lib/push/banner.ts
// 推送横幅渲染（2026-08-20 方案 C；架构 §7.4 横幅渲染）：
//   引擎推送时把已解析数值嵌入 HMAC 签名 URL，企微抓图时 GET /api/push/banner 验签后
//   sharp 现场渲染 SVG→PNG（1080×480 aspect 2.25）。中文经 SVG @font-face data URI 内嵌
//   Noto Sans SC 子集，alpine 无 CJK 字体也自包含。B2：值已嵌入 URL，路由纯渲染不查库。
import crypto from 'crypto';
import sharp from 'sharp';
import { BANNER_FONT_BASE64 } from './banner-font';

// 静态占位图 URL（迁移 203 种子值）——引擎渲染时识别它并替换为签名横幅 URL
export const BANNER_PLACEHOLDER_URL = 'https://data.shanhaiyiguo.com/push/daily-report-banner.png';

// 横幅槽位 = 种子 preset 两个 headline var 码（vertical_content_list 同款数据，无新增暴露面）
export const BANNER_SALE_VAR = 'sale_amount';
export const BANNER_RATE_VAR = 'achievement_rate';

export interface BannerParams {
  d: string;    // YYYY-MM-DD（北京日界）
  t: string;    // target_id 字符串（无目标则 ''）
  sale: string; // 销售额已格式化值（如 ¥128,500）
  rate: string; // 达成率已格式化值（如 86.4%）
}

// 北京今日（与引擎 resolveNumericValue / 调度同一日界）
export function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 签名密钥 = JWT_SECRET 派生（不跨上下文复用裸 JWT_SECRET）
function bannerSecret(): Buffer {
  const s = process.env.JWT_SECRET || '';
  if (!s) throw new Error('JWT_SECRET not set');
  return crypto.createHash('sha256').update(`${s}:push-banner`).digest();
}

// 规范化待签串（固定键序；JSON.stringify 数组避免值内含分隔符歧义）
export function canonicalBanner(p: BannerParams): string {
  return JSON.stringify([p.d, p.t, p.sale, p.rate]);
}

export function signBanner(p: BannerParams): string {
  return crypto.createHmac('sha256', bannerSecret()).update(canonicalBanner(p)).digest('base64url');
}

export function verifyBanner(p: BannerParams, sig: string): boolean {
  if (typeof sig !== 'string' || sig.length === 0) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signBanner(p));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 组装签名 URL（引擎用）——base 与 _url 变量同源（PUSH_BRIDGE_BASE_URL 剥离 /api/wecom-bridge）
export function buildBannerUrl(p: BannerParams): string {
  const base = (process.env.PUSH_BRIDGE_BASE_URL || '').replace(/\/api\/wecom-bridge$/, '');
  const q = new URLSearchParams({ d: p.d, t: p.t, sale: p.sale, rate: p.rate, sig: signBanner(p) });
  return `${base}/api/push/banner?${q.toString()}`;
}

export function hasBannerPlaceholder(cardJson: unknown): boolean {
  if (!cardJson || typeof cardJson !== 'object') return false;
  const card = cardJson as { card_image?: { url?: unknown } };
  return card.card_image?.url === BANNER_PLACEHOLDER_URL;
}

export interface MessagePresetLike { msgtype?: string; card_json?: unknown }

/** 引擎在渲染 preset 前调用：template_card + card_image 占位 + 两槽位值齐 → 注入 signed banner_url。
 *  槽位缺失 → 不注入（message-preset 保留静态占位图，优雅降级；不产生字面 {{banner_url}}）。 */
export function injectBanner(
  preset: MessagePresetLike,
  rendered: Record<string, string>,
  targetId?: number | null
): void {
  if (preset.msgtype !== 'template_card') return;
  if (!hasBannerPlaceholder(preset.card_json)) return;
  const sale = rendered[BANNER_SALE_VAR];
  const rate = rendered[BANNER_RATE_VAR];
  if (!sale || !rate) return;
  rendered.banner_url = buildBannerUrl({
    d: beijingToday(),
    t: targetId != null ? String(targetId) : '',
    sale,
    rate,
  });
}

// 渲染 SVG（纯函数，可单测）——1080×480；文案固定，层级用字号/颜色（无 font-weight bold，只有 Regular face）
export function renderBannerSvg(p: BannerParams): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="480" viewBox="0 0 1080 480">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1E40AF"/>
      <stop offset="1" stop-color="#0F2557"/>
    </linearGradient>
    <style>
      @font-face {
        font-family: 'NotoSansSC';
        src: url(data:application/font-otf;charset=utf-8;base64,${BANNER_FONT_BASE64}) format('opentype');
      }
    </style>
  </defs>
  <rect width="1080" height="480" fill="url(#bg)"/>
  <text x="56" y="76" font-family="NotoSansSC" font-size="34" fill="#94A3B8">山海数据平台</text>
  <text x="1024" y="76" font-family="NotoSansSC" font-size="34" fill="#94A3B8" text-anchor="end">${esc(p.d)}</text>
  <line x1="56" y1="108" x2="1024" y2="108" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="2"/>
  <text x="56" y="210" font-family="NotoSansSC" font-size="40" fill="#CBD5E1">销售达成</text>
  <text x="56" y="316" font-family="NotoSansSC" font-size="92" fill="#FFFFFF">${esc(p.sale)}</text>
  <text x="56" y="400" font-family="NotoSansSC" font-size="46" fill="#93C5FD">达成率 ${esc(p.rate)}</text>
</svg>
`;
}

// 进程内缓存（键=date:target；TTL + 上限，避免每日重复渲染）
interface CacheEntry { png: Buffer; expiresAt: number; at: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 64;

export async function renderBannerPng(p: BannerParams): Promise<Buffer> {
  // 键纳入全部渲染值（sale/rate 已进 URL+sig，入键安全）——避免同 (d,t) 不同分组串图
  const key = canonicalBanner(p);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.png;
  const svg = renderBannerSvg(p);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  cache.set(key, { png, expiresAt: now + CACHE_TTL_MS, at: now });
  if (cache.size > CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) { if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; } }
    if (oldestKey) cache.delete(oldestKey);
  }
  return png;
}
