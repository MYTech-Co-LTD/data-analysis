// 报表横幅 v2 数据解析 + 对象存储签名 URL（架构 §7.4；spec docs/superpowers/specs/2026-08-21-push-banner-report-v2-design.md）：
//   引擎模板引用 {{report_banner}} → 组代签 JWT 查语义视图（KPI 6 卡 + 品牌 8 列 + 战区 13 列）
//   + targets 头部 + get_data_freshness RPC → ReportBannerData → renderReportBannerPng → S3 put → 签名短 URL。
//   值不落 URL；签名覆盖 (k, expiresAt) 防永久可访问。降级：resolve/S3 失败 → null（回退占位图，不拒投）。
//   成本可见性（delivery_profit/delivery_margin）：can_cost_visible() false → NULL → 显示「—」（对齐 MaskedBadge 语义）。
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  achievementColor, marginColor, ratioColor,
  renderReportBannerPng,
  type ReportBannerData, type BannerKpiCard, type BannerBrandRow, type BannerRegionRow, type BannerTargetInfo,
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

// ─── 格式化（对齐报表中心 fmtWan / fmtCurrency / fmtRate / formatRatio / progress） ───
// 金额万化：≥10000 → X.X万；否则整数。加 ¥ 前缀；NULL → '—'
function fmtCurrency(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}
// 无前缀（KPI 副行 实际/目标 用）
function fmtWan(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(0);
}
// 率（×100, 1 位小数）；NULL → '—'
function fmtRate(r: number | null | undefined): string {
  if (r === null || r === undefined || Number.isNaN(Number(r))) return '—';
  return `${(r * 100).toFixed(1)}%`;
}
// 配销比（×100, 0 位小数，对齐 formatRatio）；NULL → '—'
function fmtRatio(r: number | null | undefined): string {
  if (r === null || r === undefined || Number.isNaN(Number(r))) return '—';
  return `${(r * 100).toFixed(0)}%`;
}
// 进度（×100, 0 位小数）
function fmtProgress(p: number | null | undefined): string {
  return p === null || p === undefined || Number.isNaN(Number(p)) ? '0' : `${(p * 100).toFixed(0)}`;
}

// 时间格式：UTC → Asia/Shanghai "YYYY-MM-DD HH:MM"（对齐 freshness.formatFreshnessChina）；失败退化截断
function fmtDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    return new Date(s)
      .toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
      .replace(/\//g, '-');
  } catch {
    return s.slice(0, 16).replace('T', ' ');
  }
}

// 视图真码（fix round 2）：report_achievement_gen 输出 mv.metric_code，join metric_definitions——
//   sale/purchase/outbound_amt/outbound_profit/delivery；sale_amount/delivery_amount 是 push 注册码，非视图码。
const KPI_LABELS: Record<string, string> = {
  sale: '销售额',
  delivery: '配送额',
  outbound_amt: '出库额',
  outbound_profit: '出库毛利',
};
const KPI_ORDER = ['sale', 'delivery', 'outbound_amt', 'outbound_profit'];

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
    // PostgREST 惯例：RPC 用 POST + {} 空 body（GET 调 POST RPC 可能失败）；非 RPC 用 GET。
    // 加 apikey 头（双通道：授权 JWT + PostgREST 角色 key，提升 RPC/targets 成功率）。
    const isRpc = url.includes('/rpc/');
    const apikey = process.env.INSFORGE_API_KEY || '';
    const resp = isRpc
      ? await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, apikey },
          body: '{}',
        })
      : await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
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
  // PR #64：KPI 只取 active 当前周期。fixed → target_id 定点；follow → 日期窗包住今天。
  // 不设 limit：report_achievement_gen 每指标一行，limit=1 会把 6 张卡截成 1 张。
  const targetFilter = opts.targetMode === 'fixed' && opts.targetId
    ? `&target_id=eq.${opts.targetId}`
    : `&start_date=lte.${today}&end_date=gte.${today}`;

  // KPI 是主查询，先完成——品牌/战区视图只认 target_id 键且无日期输出列，
  // target_id 须从 KPI 当前周期行派生（follow 日期窗锁定的行自带；fixed 行同样携带 targetId）。
  const kpiRows = await queryRows(
    `${base}/report_achievement_gen?select=target_id,name,status,start_date,end_date,metric_code,target_value,actual_value,achievement_rate,progress_rate,data_status`
    + `&target_level=eq.total&status=eq.active${targetFilter}&order=start_date.desc,end_date.asc`,
    opts.jwt,
  );
  // KPI：查询失败 → 整图失败（主板块）；空 → 空卡（占位由渲染层兜底）
  if (kpiRows === null) return null;

  // 首现去重：order=start_date.desc 新目标在前，跨重叠 active 目标时保留新目标行（only-first-wins）。
  const kpiByCode = new Map<string, Record<string, unknown>>();
  for (const r of kpiRows as Array<Record<string, unknown>>) {
    const code = String(r.metric_code);
    if (!kpiByCode.has(code)) kpiByCode.set(code, r);
  }

  // 时间进度（progress_rate）与 4 张金额卡数据——比率卡派生
  const progress = Number(kpiByCode.get('sale')?.progress_rate ?? 0);
  const amountCard = (code: string): { target: number; actual: number; rate: number | null } => {
    const r = kpiByCode.get(code);
    return {
      target: Number(r?.target_value ?? 0),
      actual: Number(r?.actual_value ?? 0),
      rate: r ? Number(r.achievement_rate) : null,
    };
  };
  const sale = amountCard('sale');
  const delivery = amountCard('delivery');
  const outboundAmt = amountCard('outbound_amt');
  const outboundProfit = amountCard('outbound_profit');

  // 4 金额卡：达成率大字（相对进度三色）+ 实际/目标/进度副行 + data_status 徽章
  const kpis: BannerKpiCard[] = KPI_ORDER
    .filter((code) => kpiByCode.has(code))
    .map((code) => {
      const r = kpiByCode.get(code) as Record<string, unknown>;
      const actual = Number(r.actual_value ?? 0);
      const target = Number(r.target_value ?? 0);
      const rateNum = r.achievement_rate == null ? null : Number(r.achievement_rate);
      const status = String(r.data_status ?? 'not_ready');
      return {
        metricCode: code,
        label: KPI_LABELS[code] ?? code,
        rate: fmtRate(rateNum),
        rateColor: achievementColor(rateNum, progress > 0 ? progress : null),
        subline: `${fmtWan(actual)}/${fmtWan(target)} · 进度 ${fmtProgress(progress)}%`,
        status,
      };
    });

  // 2 比率卡（派生，同 kpi-cards.tsx ratioCards）：总配销比（中性深色）+ 毛利率（12% 绝对三色）
  const deliverySaleRatio = sale.actual ? delivery.actual / sale.actual : null;
  const outboundMargin = outboundAmt.actual ? outboundProfit.actual / outboundAmt.actual : null;
  kpis.push(
    {
      metricCode: 'delivery_sale_ratio',
      label: '总配销比',
      rate: fmtRatio(deliverySaleRatio),
      rateColor: 'slate',
      subline: `配送${fmtWan(delivery.actual)}/销售${fmtWan(sale.actual)}`,
      status: null,
    },
    {
      metricCode: 'outbound_margin',
      label: '毛利率',
      rate: fmtRate(outboundMargin),
      rateColor: marginColor(outboundMargin),
      subline: `毛利${fmtWan(outboundProfit.actual)}/出库${fmtWan(outboundAmt.actual)} · 目标 12%`,
      status: null,
    },
  );

  // 品牌/战区：target_id 从 KPI 首行派生；派生不到 → 空数组（绝不发 target_id=eq.0 死查询）
  const rawTargetId = (kpiRows as Array<Record<string, unknown>>)[0]?.target_id;
  const panelTargetId = rawTargetId === undefined || rawTargetId === null ? null : Number(rawTargetId);
  let brands: BannerBrandRow[] = [];
  let regions: BannerRegionRow[] = [];
  if (panelTargetId !== null && !Number.isNaN(panelTargetId)) {
    const [brandRows, regionRows, wholesaleRows] = await Promise.all([
      queryRows(
        `${base}/report_brand_metric_gen?select=system_book_code,brand_name,sale_target,sale_amount,sale_rate,delivery_amount,delivery_profit,delivery_margin`
        + `&target_id=eq.${panelTargetId}&order=system_book_code.asc`,
        opts.jwt,
      ),
      queryRows(
        `${base}/report_region_breakdown_gen?select=region_name,sale_target,sale_actual,sale_rate,delivery_target,delivery_actual,delivery_rate,daily_sale,daily_delivery,remaining_daily_sale_target,remaining_daily_delivery_target`
        + `&target_id=eq.${panelTargetId}&level=eq.region&order=sale_rate.desc`,
        opts.jwt,
      ),
      queryRows(
        `${base}/report_wholesale_customer_gen?select=target_id,wholesale_amount,wholesale_profit&target_id=eq.${panelTargetId}`,
        opts.jwt,
      ),
    ]);

    // 外部批发合计：SUM 各客户行（出库金额=wholesale_amount、出库毛利=wholesale_profit、毛利率=毛利/金额）；
    // 销售类字段不填值（「—」）；cost 不可见 → 毛利/毛利率「—」。
    const wsRows = (wholesaleRows ?? []).map((r) => r as Record<string, unknown>);
    const wsAmount = wsRows.reduce((acc, r) => acc + (Number(r.wholesale_amount) || 0), 0);
    const wsProfit = wsRows.reduce((acc, r) => acc + (Number(r.wholesale_profit) || 0), 0);
    const wsMargin = wsAmount > 0 ? wsProfit / wsAmount : null;
    const costVisible = wsRows.some((r) => r.wholesale_profit !== null && r.wholesale_profit !== undefined) || wsProfit > 0;
    const externalWholesale: BannerBrandRow = {
      sbc: '外部批发',
      name: '外部批发',
      saleTarget: '—',
      saleAmount: '—',
      saleRate: '—',
      saleRateColor: 'gray',
      deliveryAmount: fmtCurrency(wsAmount > 0 ? wsAmount : null),
      deliveryRatio: '—',
      deliveryProfit: costVisible ? fmtCurrency(wsProfit > 0 ? wsProfit : null) : '—',
      deliveryMargin: costVisible && wsMargin ? fmtRate(wsMargin) : '—',
      marginColor: wsMargin ? marginColor(wsMargin) : 'gray',
      isTotal: false,
    };

    // 品牌：固定序 3120 → 64188 → 合计 → 外部批发；合计 = 视图自带合计行；局部空 → 空数组
    brands = (brandRows ?? [])
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r.system_book_code !== undefined)
      .sort((a, b) => {
        const order = (s: unknown): number =>
          String(s) === '3120' ? 0 : String(s) === '64188' ? 1 : 2;
        return order(a.system_book_code) - order(b.system_book_code);
      })
      .map((r) => {
        const isTotal = String(r.system_book_code) === '合计';
        const saleRate = r.sale_rate == null ? null : Number(r.sale_rate);
        const margin = r.delivery_margin == null ? null : Number(r.delivery_margin);
        const saleAmount = Number(r.sale_amount ?? 0);
        const deliveryAmount = Number(r.delivery_amount ?? 0);
        const ratio = saleAmount ? deliveryAmount / saleAmount : null;
        return {
          sbc: String(r.system_book_code),
          name: isTotal ? '合计' : String(r.brand_name ?? r.system_book_code),
          saleTarget: fmtCurrency(r.sale_target as number | null | undefined),
          saleAmount: fmtCurrency(r.sale_amount as number | null | undefined),
          saleRate: fmtRate(r.sale_rate as number | null | undefined),
          saleRateColor: achievementColor(saleRate, progress > 0 ? progress : null),
          deliveryAmount: fmtCurrency(r.delivery_amount as number | null | undefined),
          deliveryRatio: fmtRatio(ratio),
          deliveryProfit: r.delivery_profit == null ? '—' : fmtCurrency(r.delivery_profit as number),
          deliveryMargin: r.delivery_margin == null ? '—' : fmtRate(r.delivery_margin as number),
          marginColor: marginColor(margin),
          isTotal,
        };
      });
    // 外部批发行（合计行下方）：销售类字段「—」，出库金额/毛利/毛利率用批发客户数值
    brands.push(externalWholesale);

    // 战区：只取 level=region 行（后端已按 sale_rate desc 排序）；局部空 → 空数组
    regions = (regionRows ?? [])
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r.region_name !== undefined)
      .map((r) => {
        const saleRate = r.sale_rate == null ? null : Number(r.sale_rate);
        const deliveryRate = r.delivery_rate == null ? null : Number(r.delivery_rate);
        const deliveryActual = Number(r.delivery_actual ?? 0);
        const saleActual = Number(r.sale_actual ?? 0);
        const deliveryTarget = Number(r.delivery_target ?? 0);
        const saleTarget = Number(r.sale_target ?? 0);
        const ratioTarget = saleTarget ? deliveryTarget / saleTarget : null;
        const ratio = saleActual ? deliveryActual / saleActual : null;
        return {
          name: String(r.region_name),
          saleTarget: fmtCurrency(r.sale_target as number | null | undefined),
          saleAmount: fmtCurrency(r.sale_actual as number | null | undefined),
          saleRate: fmtRate(r.sale_rate as number | null | undefined),
          saleRateColor: achievementColor(saleRate, progress > 0 ? progress : null),
          deliveryTarget: fmtCurrency(r.delivery_target as number | null | undefined),
          deliveryAmount: fmtCurrency(r.delivery_actual as number | null | undefined),
          deliveryRate: fmtRate(r.delivery_rate as number | null | undefined),
          deliveryRateColor: achievementColor(deliveryRate, progress > 0 ? progress : null),
          dailySale: fmtCurrency(r.daily_sale as number | null | undefined),
          dailyDelivery: fmtCurrency(r.daily_delivery as number | null | undefined),
          remainingDailySaleTarget: fmtCurrency(r.remaining_daily_sale_target as number | null | undefined),
          remainingDailyDeliveryTarget: fmtCurrency(r.remaining_daily_delivery_target as number | null | undefined),
          ratioTarget: fmtRatio(ratioTarget),
          ratio: fmtRatio(ratio),
          ratioColor: ratioColor(deliveryActual, saleActual, deliveryTarget, saleTarget),
        };
      });
  }

  // 头部：target 信息从 KPI 首行派生（report_achievement_gen 已放行 total 级 RLS，
  //   直接查 targets 表会被 targets_rls_branch_nums 拦截导致空——分支 scope 不匹配 total 的 branch_num='ALL'）。
  // freshness 用 get_data_freshness RPC（SECURITY DEFINER，代签 JWT 可执行）。
  // target 查不到 / RPC 失败 → 降级（默认名/空时间），不整图失败。
  let target: BannerTargetInfo = { name: '报表', status: 'active', startDate: '', endDate: '', dataUpdatedAt: null, lastQueryAt: null };
  const kpiHead = (kpiRows as Array<Record<string, unknown>>)[0];
  if (kpiHead) {
    const frRows = await queryRows(`${base}/rpc/get_data_freshness`, opts.jwt);
    const fr = (frRows ?? [])[0] as Record<string, unknown> | undefined;
    target = {
      name: String(kpiHead.name ?? '报表'),
      status: String(kpiHead.status) === 'active' ? 'active' : 'closed',
      startDate: String(kpiHead.start_date ?? ''),
      endDate: String(kpiHead.end_date ?? ''),
      dataUpdatedAt: fmtDateTime(fr?.data_updated_at as string | null | undefined),
      lastQueryAt: fmtDateTime(fr?.last_query_at as string | null | undefined),
    };
  }

  return { target, kpis, brands, regions };
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
