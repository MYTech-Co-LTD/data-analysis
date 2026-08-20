# 推送横幅渲染（方案 C：推送时数据驱动）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** template_card `news_notice` 的 `card_image` 从静态占位图升级为推送时数据驱动的动态横幅——引擎把已解析数值嵌入 HMAC 签名 URL，企微抓图时 GET `/api/push/banner` 验签后 sharp 现场渲染 SVG→PNG。

**Architecture:** 数据流 = 推送触发 → 引擎解析变量（`renderVariables` 产出 `g.rendered`，含已格式化的 `sale_amount`/`achievement_rate`）→ 渲染 preset 时识别 card_image 静态占位 URL → 用已解析值组签名 URL 注入 `g.rendered.banner_url` → `renderPresetContent` 把占位 URL 换成签名 URL → 企微无会话抓图 → GET 路由验签（HMAC-SHA256，JWT_SECRET 派生 secret）+ d=北京今日 → 进程内缓存命中返回，否则 sharp 渲染 SVG→PNG（1080×480 aspect 2.25）。中文经 SVG `@font-face` data URI 内嵌 Noto Sans SC 子集，alpine 无 CJK 字体也自包含，dev/prod 像素一致。**B2：值已嵌入 URL，路由纯渲染不查库**。详见 `docs/architecture.md` §7.4 横幅渲染。

**Tech Stack:** Next.js App Router（Node runtime GET route）、sharp 0.34.5（提升为 web 直接依赖）、SVG + librsvg（sharp 内嵌）、Noto Sans SC 子集（fonttools pyftsubset）、vitest、HMAC-SHA256（node:crypto）。

## Global Constraints

- **架构铁律**：一切按 `docs/architecture.md` §7.4 横幅渲染执行；本计划无新表/无迁移/无 function/无 nginx 改动，只改 `web/`（引擎注入 + 新 GET 路由 + 字体资产 + package.json）。
- **B2 不二次查库**：横幅数据 = 引擎已解析的 `g.rendered` 值，签名 URL 路由**纯渲染**，GET 路由内禁止任何 PostgREST/DB 调用。
- **鉴权**：企微抓图无 cookie 会话 → URL 带 HMAC-SHA256 签名。签名密钥 = `JWT_SECRET` 派生（`sha256(JWT_SECRET + ":push-banner")`），**不直接复用裸 JWT_SECRET**。验签用 `crypto.timingSafeEqual` 常量时间比较。`d` 参数必须等于北京今日，否则 404（防回放过期数据）。
- **中文自包含**：SVG 必须经 `@font-face { src: url(data:application/font-otf;charset=utf-8;base64,…) }` 内嵌 Noto Sans SC 子集（OFL 协议，商用合规）。**禁止**依赖系统字体、**禁止**改 Dockerfile/apk 装字体。仅内嵌 Regular 字重——SVG 里**不要用 `font-weight="bold"`**（无 Bold face，librsvg 会合成/回退），层级用字号与颜色表达。
- **缓存**：进程内 Map，键 = `${d}:${t}`，TTL 24h + 上限 64 条（超限逐出最旧）。缓存命中直接返回 PNG Buffer。
- **槽位映射（v1 约定）**：横幅 sale 槽 = `g.rendered.sale_amount`、rate 槽 = `g.rendered.achievement_rate`（迁移 203 种子 preset 的两个 headline var 码，与 card vertical_content_list 同款数据）。两槽位值都解析到 → 注入 `banner_url`；任一缺失 → **不注入**，保留静态占位图（优雅降级）。
- **占位 URL 识别**：引擎识别 `card_json.card_image.url === "https://data.shanhaiyiguo.com/push/daily-report-banner.png"`（迁移 203 种子值，导出为常量 `BANNER_PLACEHOLDER_URL`）→ 注入。不修改迁移 203、不新增迁移。
- **Novu 契约不破坏**：`message-preset.ts` 的渲染契约（`{{{message_content}}}` triple-stash、无 `payload.` 前缀、deepInterpolate 语义）保持不变——横幅注入只改 card_image.url 一个字段，不改变 message_content 的 JSON 形状。
- **M7 fail-closed 不回归**：注入失败路径（槽位缺失）必须走「保留静态占位图」，**不得**在 card_json 里留下字面 `{{banner_url}}`（M7 对 message_content 扫残余 token fail-closed）。测试须钉死这条。
- **测试门（CI quality 门跑的就是这条）**：`cd web && npx tsc --noEmit` → 0 errors；`cd web && npx vitest run lib/push --reporter=default` → 全绿。实现者两个都要跑，不许只跑 vitest（esbuild 不查类型——教训见 fix-tsc-brief）。
- **npm 镜像**：装依赖用 npmmirror（`npm config set registry https://registry.npmmirror.com` 或 `--registry`），官方源极慢。
- 门店键铁律 / 外部数据 TEXT：本计划无门店 join、无迁移，不适用。回复/注释用中文。

---

### Task 1: 横幅渲染库 + 签名 + GET 路由 + 字体子集

**Files:**
- Create: `web/lib/push/banner.ts`（签名/验签/规范串/北京今日/占位常量/槽位常量/注入助手/SVG 渲染/缓存/PNG 渲染）
- Create: `web/lib/push/banner-font.ts`（Noto Sans SC 子集 base64，`export const BANNER_FONT_BASE64 = '<base64>'`）
- Create: `web/app/api/push/banner/route.ts`（GET：验签 + d 校验 → 缓存 → sharp 渲染 PNG）
- Create: `web/lib/push/__tests__/banner.test.ts`
- Create: `web/app/api/push/banner/__tests__/route.test.ts`
- Modify: `web/package.json`（`dependencies` 加 `"sharp": "^0.34.5"`）
- 一次性工具（不提交）：`/tmp/banner-font-subset.txt`（字体子集字符集）、`/tmp/banner-font.otf`（子集产物）

**Interfaces:**
- Produces（Task 2 消费）：
  - `export const BANNER_PLACEHOLDER_URL: string`
  - `export const BANNER_SALE_VAR = 'sale_amount'`, `export const BANNER_RATE_VAR = 'achievement_rate'`
  - `export interface BannerParams { d: string; t: string; sale: string; rate: string }`
  - `export function beijingToday(): string`（北京日期 YYYY-MM-DD，`new Date(Date.now() + 8*3600*1000).toISOString().slice(0,10)`）
  - `export function canonicalBanner(p: BannerParams): string`（`JSON.stringify([p.d, p.t, p.sale, p.rate])`）
  - `export function signBanner(p: BannerParams): string`（HMAC-SHA256 base64url）
  - `export function verifyBanner(p: BannerParams, sig: string): boolean`（timingSafeEqual）
  - `export function buildBannerUrl(p: BannerParams): string`（base 同 `_url` 变量：`PUSH_BRIDGE_BASE_URL` 剥离 `/api/wecom-bridge$`）
  - `export function hasBannerPlaceholder(cardJson: unknown): boolean`
  - `export function injectBanner(preset, rendered: Record<string,string>, targetId?: number|null): void`（Task 2 调用；见下）
  - `export function renderBannerSvg(p: BannerParams): string`（纯函数，SVG 字符串）
  - `export async function renderBannerPng(p: BannerParams): Promise<Buffer>`（sharp + 缓存）

- [ ] **Step 1: 写失败测试（banner.test.ts）**

覆盖：`signBanner`/`verifyBanner`（真签名过、任一参数篡改不过、sig 空/长度不等不过）、`buildBannerUrl`（含 `/api/push/banner` 与 d/t/sale/rate/sig 参数；base 从 `PUSH_BRIDGE_BASE_URL` 推导——`https://data.shanhaiyiguo.com/api/wecom-bridge` → `https://data.shanhaiyiguo.com/api/push/banner?...`）、`renderBannerSvg`（含 sale/rate 文本、含 `@font-face` 与 `data:application/font-otf;charset=utf-8;base64,`、XML 转义特殊字符）、`beijingToday`、`hasBannerPlaceholder`（占位 URL true / 其它 false / 无 card_image false）、`injectBanner`（槽位齐 → `rendered.banner_url` 为签名 URL 且 `buildBannerUrl` 可解析；rate 缺失 → 不注入；msgtype 非 template_card → 不注入）、`renderBannerPng` 缓存（`vi.mock('sharp')`：首次调 sharp，二次缓存命中不再调；TTL 过期重建；超上限逐出最旧）。

测试骨架（真实代码写在 plan 里，Task 1 实现者按此执行）：
```typescript
// web/lib/push/__tests__/banner.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beijingToday, canonicalBanner, signBanner, verifyBanner, buildBannerUrl,
  renderBannerSvg, hasBannerPlaceholder, injectBanner, BANNER_PLACEHOLDER_URL,
} from '../banner';

vi.stubEnv('JWT_SECRET', 'test-secret-0123456789abcdef');
vi.stubEnv('PUSH_BRIDGE_BASE_URL', 'https://data.shanhaiyiguo.com/api/wecom-bridge');

const p = { d: '2026-08-20', t: '123', sale: '¥128,500', rate: '86.4%' };

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
    injectBanner(preset as any, rendered, 123);
    expect(rendered.banner_url).toMatch(/\/api\/push\/banner\?/);
    expect(rendered.banner_url).toContain(encodeURIComponent('¥128,500'));
  });
  it('rate 缺失 → 不注入（优雅降级）', () => {
    const rendered: Record<string, string> = { sale_amount: '¥128,500' };
    injectBanner(preset as any, rendered, 123);
    expect(rendered.banner_url).toBeUndefined();
  });
  it('card_image 非占位 → 不注入', () => {
    const preset2 = { msgtype: 'template_card', card_json: { card_image: { url: 'https://x/y.png' } } };
    const rendered: Record<string, string> = { sale_amount: '¥1', achievement_rate: '50%' };
    injectBanner(preset2 as any, rendered, 1);
    expect(rendered.banner_url).toBeUndefined();
  });
});

describe('renderBannerPng 缓存', () => {
  it('首次渲染调 sharp，二次命中缓存不调', async () => {
    const sharpMock = vi.fn(() => ({ png: () => ({ toBuffer: async () => Buffer.from('PNG') }) }));
    vi.doMock('sharp', () => ({ default: sharpMock }));
    const { renderBannerPng } = await import('../banner');
    const a = await renderBannerPng(p);
    const b = await renderBannerPng(p);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a).toEqual(b);
    expect(sharpMock).toHaveBeenCalledTimes(1);
    vi.doUnmock('sharp');
  });
});
```

> 注：`renderBannerPng` 测试的 `vi.doMock('sharp')` 若与模块顶层 `import sharp from 'sharp'` 冲突，改用「缓存测试只断言 `getCachedBanner`/逐出逻辑」的纯单元测试 + `vi.mock('sharp')` 顶层 mock。实现者二选一，保证缓存命中路径不实际调 sharp。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run lib/push/__tests__/banner.test.ts --reporter=default
```
Expected: FAIL（`banner.ts` 不存在 → import 错误）。

- [ ] **Step 3: 生成字体子集 + banner-font.ts**

先确认源字体在 `/tmp/NotoSansSC-Regular.otf`（4.8M，OFL）。从下面 SVG 模板抄出全部文本字符 + 值字符，写进字符集文件：

```bash
cat > /tmp/banner-font-subset.txt <<'EOF'
山海数据平台销售达成率 0123456789.,-+%¥:/()
EOF
# 再补上空格与换行后的实际模板字符（实现者以最终 SVG 模板的文本为准确认包含）
python3 -m fontTools.subset /tmp/NotoSansSC-Regular.otf \
  --output-file=/tmp/banner-font.otf \
  --text-file=/tmp/banner-font-subset.txt \
  --no-hinting
ls -lh /tmp/banner-font.otf   # 预期几 KB~几十 KB
```

把子集 base64 写进 `web/lib/push/banner-font.ts`：
```bash
cd web
node -e "const fs=require('fs');const b=fs.readFileSync('/tmp/banner-font.otf').toString('base64');fs.writeFileSync('lib/push/banner-font.ts',`// Noto Sans SC 子集（OFL）base64——SVG @font-face data URI 内嵌，alpine 无 CJK 字体也自包含。\n// 由 fontTools pyftsubset 从 /tmp/NotoSansSC-Regular.otf 生成，勿手改。\nexport const BANNER_FONT_BASE64 = '${b}';\n`)"
wc -c lib/push/banner-font.ts   # 预期 < 100KB
```
> 若 `--text-file` 漏了某模板字符，sharp 渲染会出豆腐块（□）——生成后用一个含全部模板文本的 SVG 实测（见 Step 6）。

- [ ] **Step 4: 实现 banner.ts**

```typescript
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
  const key = `${p.d}:${p.t}`;
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
```

> 注：`Date.now()` 在测试里可用；`renderBannerPng` 的缓存测试用 `vi.mock('sharp')` 顶层 mock 避免真实渲染。

- [ ] **Step 5: 实现 GET 路由 route.ts**

```typescript
// web/app/api/push/banner/route.ts
// 横幅 GET 路由（架构 §7.4 横幅渲染）：验签 + d=北京今日 → 缓存命中返回 PNG，否则 sharp 现场渲染。
// 企微无会话抓图，URL 带 HMAC 签名；B2：值已嵌入 URL，本路由纯渲染不查库。
import { NextRequest, NextResponse } from 'next/server';
import { verifyBanner, renderBannerPng, beijingToday, type BannerParams } from '../../../lib/push/banner';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
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
    return new NextResponse(png, {
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
```
> import 相对路径：`route.ts` 在 `web/app/api/push/banner/`，lib 在 `web/lib/push/`，用 `../../../lib/push/banner`；若仓库有 `@/` 别名（查 `web/tsconfig.json` paths）也可用别名。跟 `web/app/api/push/route.ts` 现有 import 风格一致。

- [ ] **Step 6: 真实渲染冒烟（dev 环境，可选但强烈建议）**

```bash
cd web
node -e "
const { renderBannerPng } = require('./lib/push/banner.ts'); // 或先 tsc 编译后引用
" 2>/dev/null || echo '用 vitest 集成代替'
# 实测：写一个临时脚本调 renderBannerSvg → sharp 渲染 → 保存 PNG → 肉眼/像素核验中文非豆腐块
```
若无法直调 TS，则加一个临时 vitest 用例：`renderBannerPng(p)` 真实渲染并断言输出 PNG 非空 + 尺寸 1080×480（`sharp(buf).metadata()`），跑完删除该临时用例。中文豆腐块（□）检查：把渲染 PNG 转 base64 用 node zlib 解 RGBA，统计含「销售达成」区域是否有非背景像素（或直接看测试里 `sharp` 不抛错 + 尺寸正确即认为渲染通路 OK——像素级中文验证已在设计阶段做过）。

- [ ] **Step 7: 加 sharp 直接依赖**

```bash
cd web
npm install sharp@0.34.5 --save --registry=https://registry.npmmirror.com
grep -n '"sharp"' package.json   # dependencies 里出现
```

- [ ] **Step 8: 跑路由测试（route.test.ts）**

```typescript
// web/app/api/push/banner/__tests__/route.test.ts
// 验签 + d 校验 → 403/404/400/200 四态钉死；renderBannerPng mock 掉避免真实 sharp。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signBanner, beijingToday } from '../../../lib/push/banner';

const { GET } = await import('../route');

const mkParams = (over: Record<string, string> = {}) => {
  const p = { d: beijingToday(), t: '123', sale: '¥128,500', rate: '86.4%' };
  return { ...p, ...over };
};

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../../../lib/push/banner', async () => {
    const actual = await import('../../../lib/push/banner');
    return {
      ...actual,
      renderBannerPng: vi.fn(async () => Buffer.from('PNGDATA')),
    };
  });
});

describe('GET /api/push/banner', () => {
  it('签名有效 + 今日 → 200 image/png', async () => {
    const p = mkParams();
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new Request(url) as any);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('Content-Type')).toBe('image/png');
  });
  it('签名无效 → 403', async () => {
    const p = mkParams();
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig: 'bad' }).toString()}`);
    const resp = await GET(new Request(url) as any);
    expect(resp.status).toBe(403);
  });
  it('d 非北京今日 → 404（防回放过期数据）', async () => {
    const p = mkParams({ d: '2026-08-19' });
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new Request(url) as any);
    expect(resp.status).toBe(404);
  });
  it('缺 sale/rate → 400', async () => {
    const p = mkParams({ sale: '', rate: '' });
    const sig = signBanner(p);
    const url = new URL(`https://data.shanhaiyiguo.com/api/push/banner?${new URLSearchParams({ ...p, sig }).toString()}`);
    const resp = await GET(new Request(url) as any);
    expect(resp.status).toBe(400);
  });
});
```
> `vi.doMock` 里 mock `renderBannerPng`——注意 mock 模块后 `signBanner` 仍是真实现（展开 actual 只覆盖 `renderBannerPng`）。

- [ ] **Step 9: 全量测试 + 类型检查 + commit**

```bash
cd web && npx tsc --noEmit                    # → 0 errors（GHA quality 门 Type check 步）
cd web && npx vitest run lib/push --reporter=default   # → 全绿
```
提交（含生成的字体资产）：
```bash
git add web/lib/push/banner.ts web/lib/push/banner-font.ts web/app/api/push/banner/ web/lib/push/__tests__/banner.test.ts web/package.json web/package-lock.json
git commit -m "feat(push): 横幅渲染库+签名 GET 路由——HMAC 验签 + sharp 现场渲染 SVG→PNG（方案 C，架构 §7.4）
- banner.ts：签名/验签/北京今日/槽位映射/SVG 模板/进程内缓存（TTL+上限）
- route.ts：验签 + d=北京今日 + 缓存命中返回，纯渲染不查库
- 字体子集 banner-font.ts：Noto Sans SC 子集 base64（OFL），SVG @font-face 内嵌自包含
- sharp 提升为 web 直接依赖（0.34.5）"
```
> 只提交 Task 1 文件，`message-preset.ts`/`index.ts`（Task 2）不动。

**Task 1 report：** 写到 `.superpowers/sdd/2026-08-20-push-banner-render/task-1-report.md`——改动的文件、字体子集大小、tsc 输出、vitest 摘要、commit hash、concerns。返回只回状态、commit、tsc、vitest 摘要。

---

### Task 2: 引擎注入 + message-preset 占位替换

**Files:**
- Modify: `web/lib/push/index.ts`（渲染 preset 循环里调 `injectBanner`）
- Modify: `web/lib/push/message-preset.ts`（template_card 分支：card_image.url === 占位且 vars.banner_url 存在 → 替换）
- Create: `web/lib/push/__tests__/message-preset-banner.test.ts`

**Interfaces:**
- Consumes（Task 1 产出）：`injectBanner`, `hasBannerPlaceholder`, `BANNER_PLACEHOLDER_URL` from `./banner`
- Preserves：`renderPresetContent(preset, vars)` 签名与返回 JSON 契约不变

- [ ] **Step 1: 写失败测试（message-preset-banner.test.ts）**

```typescript
// web/lib/push/__tests__/message-preset-banner.test.ts
// 横幅占位替换（Task 2）：card_image.url 占位 + vars.banner_url → 替换为签名 URL；
// 无 banner_url → 保留占位；非占位 url → 不动；非 template_card → 不涉及。
import { describe, it, expect } from 'vitest';
import { renderPresetContent } from '../message-preset';
import { BANNER_PLACEHOLDER_URL } from '../banner';

const preset: any = {
  preset_id: 'scheduled-report-card',
  workflow_id: 'scheduled-report',
  msgtype: 'template_card',
  card_json: {
    card_type: 'news_notice',
    main_title: { title: '📊 数据日报', desc: '销售 {{sale_amount}} · 达成率 {{achievement_rate}}' },
    card_image: { url: BANNER_PLACEHOLDER_URL, aspect_ratio: 2.25 },
    vertical_content_list: [
      { title: '销售额', value: '{{sale_amount}}' },
      { title: '达成率', value: '{{achievement_rate}}' },
    ],
  },
};

describe('renderPresetContent 横幅占位替换', () => {
  it('vars.banner_url 存在 → card_image.url 换成签名 URL，其余字段不变', () => {
    const mc = renderPresetContent(preset, {
      sale_amount: '¥128,500', achievement_rate: '86.4%',
      banner_url: 'https://data.shanhaiyiguo.com/api/push/banner?d=2026-08-20&t=123&sig=abc',
    });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe('https://data.shanhaiyiguo.com/api/push/banner?d=2026-08-20&t=123&sig=abc');
    expect(json.template_card.vertical_content_list[0].value).toBe('¥128,500');
    expect(json.template_card.card_type).toBe('news_notice');
  });
  it('无 banner_url → 保留占位图（优雅降级）', () => {
    const mc = renderPresetContent(preset, { sale_amount: '¥128,500', achievement_rate: '86.4%' });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe(BANNER_PLACEHOLDER_URL);
  });
  it('card_image.url 非占位（如 {{banner_url}} 模板 token 或自定义）→ 不破坏', () => {
    const p2 = { ...preset, card_json: { ...preset.card_json, card_image: { url: '{{banner_url}}', aspect_ratio: 2.25 } } };
    const mc = renderPresetContent(p2, { sale_amount: '¥1', achievement_rate: '50%', banner_url: 'https://x/y' });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe('https://x/y'); // deepInterpolate 自然解析 token
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run lib/push/__tests__/message-preset-banner.test.ts --reporter=default
```
Expected: FAIL（第一个用例 card_image.url 仍是占位）。

- [ ] **Step 3: message-preset.ts template_card 分支加占位替换**

在 `template_card` 分支 `deepInterpolate` 之后、`JSON.stringify` 之前插入：

```typescript
    case 'template_card': {
      const card = preset.card_json;
      if (card && typeof card === 'object' && !Array.isArray(card)) {
        const interpolated = deepInterpolate(card, vars) as { card_image?: { url?: unknown } };
        // 横幅占位图 → 签名横幅 URL（架构 §7.4 方案 C；vars.banner_url 由引擎 injectBanner 注入。
        //   槽位缺失时引擎不注入 banner_url → 保留静态占位图优雅降级，不产生字面 {{banner_url}}）
        if (
          interpolated.card_image?.url === BANNER_PLACEHOLDER_URL &&
          typeof vars.banner_url === 'string'
        ) {
          interpolated.card_image.url = vars.banner_url;
        }
        return JSON.stringify({
          msgtype: 'template_card',
          template_card: interpolated,
        });
      }
      // ...原简写分支不动
```
> import 顶部加 `import { BANNER_PLACEHOLDER_URL } from './banner';`。注意别把 `vars.banner_url` 写进 vertical_content_list——注入只发生在 `g.rendered`（vars），deepInterpolate 只替换 `{{var}}` token，`banner_url` 键不进 card 除非模板引用。

- [ ] **Step 4: index.ts 渲染 preset 循环里调 injectBanner**

在 `web/lib/push/index.ts` 渲染 preset 处（约 434-439 行 `const preset = await loadWorkflowPreset(...)` 的 `if (preset)` 循环内、`renderPresetContent` 调用之前）加一行：

```typescript
  if (preset) {
    for (const g of renderedGroups) {
      // 横幅注入（架构 §7.4 方案 C）：template_card + card_image 占位 + 槽位值齐 → 组签名 URL 进 banner_url
      injectBanner(preset, g.rendered, opts.targetId);
      g.rendered.message_content = renderPresetContent(preset, g.rendered);
    }
  }
```
> import 顶部加 `import { injectBanner } from './banner';`。`opts.targetId` 已是 `number | undefined`（RunPush 接口透传，见 manifest.ts 调用方）。`injectBanner` 内部已处理 msgtype 校验/占位校验/槽位缺失降级。

- [ ] **Step 5: 全量测试 + 类型检查 + commit**

```bash
cd web && npx tsc --noEmit                    # → 0 errors
cd web && npx vitest run lib/push lib/jobs --reporter=default   # → 全绿（含既有回归 113+）
git add web/lib/push/index.ts web/lib/push/message-preset.ts web/lib/push/__tests__/message-preset-banner.test.ts
git commit -m "feat(push): 引擎注入横幅签名 URL——渲染 preset 时占位图替换为 /api/push/banner 签名链（方案 C）
- index.ts：renderVariables 后调 injectBanner（槽位值齐才注入，缺失保留静态占位图降级）
- message-preset.ts：card_image.url 占位 + vars.banner_url → 替换；契约与 M7 不回归"
```

**Task 2 report：** 写到 `.superpowers/sdd/2026-08-20-push-banner-render/task-2-report.md`——改动点、tsc 输出、vitest 摘要（含既有回归）、commit hash、concerns。返回只回状态、commit、tsc、vitest 摘要。
