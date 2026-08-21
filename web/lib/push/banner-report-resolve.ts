// 报表横幅数据解析 + 对象存储签名 URL（架构 §7.4 2026-08-21；spec docs/superpowers/specs/2026-08-21-push-banner-report-design.md）：
//   引擎模板引用 {{report_banner}} → 组代签 JWT 查 3 语义视图 → ReportBannerData
//   → renderReportBannerPng → S3 put(push-assets/banner/<uuid>.png) → 签名短 URL /api/push/banner?k&e&sig。
//   值不落 URL（中文名编码超 1024B）；签名覆盖 (k, expiresAt) 防永久可访问——路由须还原 e 才能验签。
//   降级：resolve 失败 / S3 失败 → null（调用方回退占位图，不拒投——Task 5）。
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  rateColor, renderReportBannerPng,
  type ReportBannerData, type BannerKpiCard, type BannerBrandRow, type BannerRegionRow,
} from './banner-report';
import { bannerKey, type BannerStorage } from './banner-storage';

export const REPORT_BANNER_VAR = 'report_banner';
export const REPORT_BANNER_TOKEN = '{{report_banner}}';
export const BANNER_URL_TTL_MS = 24 * 3600 * 1000;

function bannerSecret(): Buffer {
  const s = process.env.JWT_SECRET || '';
  if (!s) throw new Error('JWT_SECRET not set');
  return crypto.createHash('sha256').update(`${s}:push-banner`).digest();
}

export function templateRefersReportBanner(cardJson: unknown): boolean {
  if (!cardJson || typeof cardJson !== 'object' || Array.isArray(cardJson)) return false;
  const seen = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (typeof node === 'string') return node.includes(REPORT_BANNER_TOKEN);
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    return Object.values(node as Record<string, unknown>).some(walk);
  };
  return walk(cardJson);
}

export function signBannerObject(k: string, expiresAt: number): string {
  const canonical = JSON.stringify([k, expiresAt]);
  return crypto.createHmac('sha256', bannerSecret()).update(canonical).digest('base64url');
}

export function verifyBannerObject(k: string, expiresAt: number, sig: string): boolean {
  if (typeof sig !== 'string' || sig.length === 0) return false;
  const expected = Buffer.from(signBannerObject(k, expiresAt));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function bannerExpiresAt(now: number): number {
  return now + BANNER_URL_TTL_MS;
}

const fmtCN = (n: number): string => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(n));

const KPI_LABELS: Record<string, string> = {
  sale_amount: '销售额',
  delivery_amount: '配送额',
  outbound_amt: '出库额',
  outbound_profit: '出库毛利',
};
const KPI_ORDER = ['sale_amount', 'delivery_amount', 'outbound_amt', 'outbound_profit'];

const fmtRate = (r: number | null | undefined): string =>
  r === null || r === undefined || Number.isNaN(Number(r)) || Number(r) <= 0 ? '--' : `${(Number(r) * 100).toFixed(1)}%`;

const fmtMoney = (v: number | null | undefined): string =>
  v === null || v === undefined ? '--' : `¥${fmtCN(Number(v))}`;

function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export interface BannerResolveOpts {
  jwt: string;
  targetMode: 'follow' | 'fixed';
  targetId?: number;
  postgrestUrl?: string;
}

async function queryRows(url: string, jwt: string): Promise<unknown[] | null> {
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
    if (!resp.ok) return null;
    const rows = (await resp.json()) as unknown;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

export async function resolveReportBannerData(opts: BannerResolveOpts): Promise<ReportBannerData | null> {
  const base = opts.postgrestUrl ?? process.env.POSTGREST_URL ?? '';
  if (!base) return null;
  const today = beijingToday();
  // PR #64：KPI 只取 active 当前周期单行。fixed → target_id 定点；follow → 日期窗包住今天。
  const targetFilter = opts.targetMode === 'fixed' && opts.targetId
    ? `&target_id=eq.${opts.targetId}`
    : `&start_date=lte.${today}&end_date=gte.${today}`;
  // 品牌/战区视图以 target_id 为键（follow 无定点 id 时用 0 占位——Task 5 接线确认真实用法）
  const brandTargetId = opts.targetId ?? 0;

  const [kpiRows, brandRows, regionRows] = await Promise.all([
    queryRows(
      `${base}/report_achievement_gen?select=metric_code,target_value,actual_value,achievement_rate`
      + `&target_level=eq.total&status=eq.active${targetFilter}&order=start_date.desc,end_date.asc&limit=1`,
      opts.jwt,
    ),
    queryRows(
      `${base}/report_brand_metric_gen?select=system_book_code,brand_name,sale_amount,sale_rate`
      + `&target_id=eq.${brandTargetId}&order=system_book_code.asc`,
      opts.jwt,
    ),
    queryRows(
      `${base}/report_region_breakdown_gen?select=region_name,sale_actual,sale_rate`
      + `&target_id=eq.${brandTargetId}&level=eq.region&order=sale_rate.desc`,
      opts.jwt,
    ),
  ]);

  // KPI：查询失败 → 整图失败（主板块）；空 → 空卡（占位由渲染层兜底）
  if (kpiRows === null) return null;
  const kpiByCode = new Map((kpiRows as Array<Record<string, unknown>>).map((r) => [r.metric_code, r]));
  const kpis: BannerKpiCard[] = KPI_ORDER
    .filter((code) => kpiByCode.has(code))
    .map((code) => {
      const r = kpiByCode.get(code) as Record<string, unknown>;
      const rateNum = Number(r.achievement_rate ?? 0);
      return {
        metricCode: code,
        label: KPI_LABELS[code] ?? code,
        value: fmtMoney(r.actual_value as number | null | undefined),
        rate: fmtRate(r.achievement_rate as number | null | undefined),
        rateColor: rateColor(rateNum > 0 ? rateNum : null),
      };
    });

  // 品牌：固定序 3120 → 64188 → 合计（合计 = 视图自带合计行）；局部空 → 空数组
  const brands: BannerBrandRow[] = (brandRows ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r.system_book_code !== undefined)
    .sort((a, b) => {
      const order = (s: unknown): number =>
        String(s) === '3120' ? 0 : String(s) === '64188' ? 1 : 2;
      return order(a.system_book_code) - order(b.system_book_code);
    })
    .map((r) => {
      const rateNum = Number(r.sale_rate ?? 0);
      return {
        sbc: String(r.system_book_code),
        name: String(r.brand_name ?? r.system_book_code),
        sale: fmtMoney(r.sale_amount as number | null | undefined),
        rate: fmtRate(r.sale_rate as number | null | undefined),
        rateColor: rateColor(rateNum > 0 ? rateNum : null),
      };
    });

  // 战区：只取 level=region 行（后端已按 sale_rate desc 排序）；局部空 → 空数组
  const regions: BannerRegionRow[] = (regionRows ?? [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r.region_name !== undefined)
    .map((r) => {
      const rateNum = Number(r.sale_rate ?? 0);
      return {
        name: String(r.region_name),
        sale: fmtMoney(r.sale_actual as number | null | undefined),
        rate: fmtRate(r.sale_rate as number | null | undefined),
        rateColor: rateColor(rateNum > 0 ? rateNum : null),
      };
    });

  return { date: today, kpis, brands, regions };
}

export async function buildReportBannerUrl(data: ReportBannerData, storage: BannerStorage): Promise<string | null> {
  try {
    const png = await renderReportBannerPng(data);
    const id = randomUUID();
    const key = bannerKey(id);
    await storage.put(key, png, 'image/png');
    const exp = bannerExpiresAt(Date.now());
    const sig = signBannerObject(id, exp);
    const base = (process.env.PUSH_BRIDGE_BASE_URL || '').replace(/\/api\/wecom-bridge$/, '');
    return `${base}/api/push/banner?k=${encodeURIComponent(id)}&e=${encodeURIComponent(String(exp))}&sig=${encodeURIComponent(sig)}`;
  } catch {
    return null;
  }
}
