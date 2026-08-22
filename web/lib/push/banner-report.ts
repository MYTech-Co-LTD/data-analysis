// 报表数据横幅 SVG/PNG 渲染 v2（spec docs/superpowers/specs/2026-08-21-push-banner-report-v2-design.md）：
//   白底原样还原报表中心——头部（目标名/状态徽章/日期/数据更新/最近查询）+ KPI 6 卡（4 金额 + 2 比率）
//   + 品牌 8 列表格 + 战区 13 列表格，1080 宽，高度按内容 ≤830（aspect ≥1.3）。
//   达成率相对进度三色（rate/progress）+ 毛利率绝对三色（12% 目标），对齐 kpi-cards/brand-metric-table/region-drill-table。
//   纯函数可单测；sharp 在 renderReportBannerPng（无进程内缓存——对象存储即缓存）。
import sharp from 'sharp';
import { BANNER_FONT_BASE64 } from './banner-font';

export type RateColor = 'green' | 'amber' | 'red' | 'gray' | 'slate';

// 相对进度达成率三色（对齐报表中心 rateColor + progress）：
//   相对 = rate / max(progress, 0.0001)：≥1 绿 / ≥0.8 琥珀 / <0.8 红；
//   progress 缺省/0 → 退化绝对达成率三色；rate null/NaN → 灰。
export function achievementColor(rate: number | null | undefined, progress?: number | null): RateColor {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return 'gray';
  const r = progress == null || progress === 0 ? rate : rate / Math.max(progress, 0.0001);
  if (r >= 1) return 'green';
  if (r >= 0.8) return 'amber';
  return 'red';
}

// 毛利率绝对三色（对齐 absoluteThreeColor(marginAchievement(margin, 0.12))）：
//   ≥12% 绿 / ≥9.6% 琥珀 / <9.6% 红；null/NaN（成本脱敏）→ 灰。
export function marginColor(margin: number | null | undefined): RateColor {
  if (margin === null || margin === undefined || Number.isNaN(margin)) return 'gray';
  const a = margin / 0.12;
  if (a >= 1) return 'green';
  if (a >= 0.8) return 'amber';
  return 'red';
}

// 配销比达成率绝对三色（对齐 region-drill-table：实际配销比 / 目标配销比）。
export function ratioColor(
  deliveryActual: number | null | undefined, saleActual: number | null | undefined,
  deliveryTarget: number | null | undefined, saleTarget: number | null | undefined,
): RateColor {
  if (!saleActual || !saleTarget || !deliveryTarget) return 'gray';
  const ach = (deliveryActual! / saleActual) / (deliveryTarget / saleTarget);
  if (ach >= 1) return 'green';
  if (ach >= 0.8) return 'amber';
  return 'red';
}

export function rateColorHex(c: RateColor): string {
  switch (c) {
    case 'green': return '#16A34A';
    case 'amber': return '#D97706';
    case 'red': return '#DC2626';
    case 'slate': return '#1E293B'; // 中性深色（总配销比大字/普通数值）
    default: return '#94A3B8';      // gray：无数据/脱敏
  }
}

// 状态徽章（data_status）：complete=绿底绿字 / partial=琥珀 / missing=红 / not_ready=灰
export function statusBadgeColor(status: string): { bg: string; text: string } {
  switch (status) {
    case 'complete': return { bg: '#F0FDF4', text: '#15803D' };
    case 'partial': return { bg: '#FFFBEB', text: '#B45309' };
    case 'missing': return { bg: '#FEF2F2', text: '#B91C1C' };
    default: return { bg: '#F1F5F9', text: '#94A3B8' };
  }
}

// 状态徽章文案（对齐 report-center statusToZh）
export function statusToZh(code: string): string {
  const MAP: Record<string, string> = { complete: '已完成', partial: '部分', missing: '缺失', not_ready: '未就绪' };
  return MAP[code] ?? '未就绪';
}

export interface BannerTargetInfo {
  name: string;
  status: 'active' | 'closed';
  startDate: string;
  endDate: string;
  dataUpdatedAt: string | null; // 已格式化 YYYY-MM-DD HH:MM
  lastQueryAt: string | null;
}
export interface BannerKpiCard {
  metricCode: string;
  label: string;                 // 销售额/配送额/出库额/出库毛利/总配销比/毛利率
  rate: string;                  // 达成率或比率大字（如 60.6% / 28.8%）
  rateColor: RateColor;          // 金额卡=相对进度三色；总配销比=slate；毛利率=绝对三色
  subline: string;               // 实际/目标 · 进度 N%  或  配送X/销售Y · 目标 12%
  status: string | null;         // data_status 徽章文案；比率卡无徽章 → null
}
export interface BannerBrandRow {
  sbc: string;
  name: string;
  saleTarget: string;
  saleAmount: string;
  saleRate: string;
  saleRateColor: RateColor;      // 相对进度三色
  deliveryAmount: string;
  deliveryRatio: string;         // 配销比 = 配送/销售
  deliveryProfit: string;        // 成本隐藏 → '—'
  deliveryMargin: string;        // 成本隐藏 → '—'
  marginColor: RateColor;        // 绝对三色；null → gray
  isTotal: boolean;
}
export interface BannerRegionRow {
  name: string;
  saleTarget: string; saleAmount: string; saleRate: string; saleRateColor: RateColor;
  deliveryTarget: string; deliveryAmount: string; deliveryRate: string; deliveryRateColor: RateColor;
  dailySale: string; dailyDelivery: string;
  remainingDailySaleTarget: string; remainingDailyDeliveryTarget: string;
  ratioTarget: string;           // 配销比目标（中性色，对齐报表中心 text-slate-400）
  ratio: string;                 // 配销比
  ratioColor: RateColor;         // 配销比达成率绝对三色
}
export interface ReportBannerData {
  target: BannerTargetInfo;
  kpis: BannerKpiCard[];
  brands: BannerBrandRow[];
  regions: BannerRegionRow[];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ─── 布局常量（1080 宽，高度按内容） ───
const W = 1080;
const MX = 40;            // 左右边距 → 内容区 40..1040
const MIN_H = 700;        // 高度下限（保持 aspect ≈1.3-1.5 的协调感）

const HEAD_TOP = 36;
const HEAD_TITLE_Y = 62;  // 目标名基线
const HEAD_META_Y = 92;   // 日期 + 数据更新 + 最近查询
const HEAD_DIV_Y = 116;   // 分隔线

const KPI_TOP = 132;
const KPI_H = 138;
const KPI_GAP = 12;
const KPI_W = (W - 2 * MX - 5 * KPI_GAP) / 6; // (1080-80-60)/6 = 156.7

const BRAND_TOP = 286;         // 品牌表块顶部（标题）
const BRAND_ROW_H = 30;
const REGION_ROW_H = 28;

const EMPTY_H = 56;            // 空表占位高度

function fontFace(): string {
  return `<style>@font-face{font-family:'NotoSansSC';src:url(data:application/font-otf;charset=utf-8;base64,${BANNER_FONT_BASE64}) format('opentype');}</style>`;
}

function badge(status: string | null, cx: number, y: number): string {
  if (!status) return '';
  const { bg, text } = statusBadgeColor(status);
  const label = statusToZh(status);
  // 徽章：圆角矩形 + 居中文字；宽度按 3 字（未就绪）估 54
  const w = 54, h = 22;
  return `
  <rect x="${cx - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="6" fill="${bg}"/>
  <text x="${cx}" y="${y + 4}" text-anchor="middle" font-family='NotoSansSC' font-size="12" fill="${text}">${esc(label)}</text>`;
}

function kpiCards(kpis: BannerKpiCard[]): string {
  if (kpis.length === 0) return `<text x="${MX}" y="${KPI_TOP + 40}" font-family='NotoSansSC' font-size="20" fill="#94A3B8">暂无数据</text>`;
  return kpis.map((k, i) => {
    const x = MX + i * (KPI_W + KPI_GAP);
    return `
  <rect x="${x}" y="${KPI_TOP}" width="${KPI_W}" height="${KPI_H}" rx="10" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1"/>
  <text x="${x + 14}" y="${KPI_TOP + 26}" font-family='NotoSansSC' font-size="13" fill="#64748B">${esc(k.label)}</text>
  ${badge(k.status, x + KPI_W - 12, KPI_TOP + 20)}
  <text x="${x + 14}" y="${KPI_TOP + 74}" font-family='NotoSansSC' font-size="27" font-weight="600" fill="${rateColorHex(k.rateColor)}">${esc(k.rate)}</text>
  <text x="${x + 14}" y="${KPI_TOP + 108}" font-family='NotoSansSC' font-size="12" fill="#94A3B8">${esc(k.subline)}</text>`;
  }).join('');
}

// ─── 通用表格渲染（0 基准；返回 { svg, height }，height 供高度计算） ───
interface ColSpec<R> {
  label: string;
  w: number;                      // 列宽（数值列右对齐锚点 = 列右缘）
  align: 'left' | 'right';
  value: (r: R) => string;
  color?: (r: R) => string;
}

function renderTable<R>(
  title: string,
  x0: number,
  cols: ColSpec<R>[],
  rows: R[],
  opts: { rowH: number; headH: number; titleH: number; rowBg?: (r: R) => string | null },
): { svg: string; height: number } {
  let y = opts.titleH;
  const headY = y + opts.headH;
  // 列 x 锚点：从左到右累加列宽（左对齐列锚左缘+8；右对齐列锚右缘-8）
  const colAnchors = (() => {
    const anchors: { ax: number; an: string }[] = [];
    let acc = x0;
    for (const c of cols) {
      acc += c.w;
      anchors.push({
        ax: c.align === 'left' ? acc - c.w + 8 : acc - 8,
        an: c.align === 'left' ? 'start' : 'end',
      });
    }
    return anchors;
  })();
  // 表头（bg-slate-50 #F8FAFC，文字 slate-500 #64748B）
  let out = `
  <text x="${x0}" y="${22}" font-family='NotoSansSC' font-size="16" font-weight="600" fill="#334155">${esc(title)}</text>
  <rect x="${x0}" y="${opts.titleH}" width="${W - 2 * MX}" height="${opts.headH}" rx="6" fill="#F8FAFC"/>
  ${cols.map((c, i) => {
    const { ax, an } = colAnchors[i];
    return `<text x="${ax}" y="${headY - 8}" text-anchor="${an}" font-family='NotoSansSC' font-size="12" fill="#64748B">${esc(c.label)}</text>`;
  }).join('')}`;
  y = headY;
  if (rows.length === 0) {
    out += `<text x="${x0 + 8}" y="${y + EMPTY_H / 2}" font-family='NotoSansSC' font-size="16" fill="#94A3B8">暂无数据</text>`;
    return { svg: out, height: y + EMPTY_H };
  }
  for (const r of rows) {
    const bg = opts.rowBg ? opts.rowBg(r) : null;
    if (bg) out += `<rect x="${x0}" y="${y}" width="${W - 2 * MX}" height="${opts.rowH}" fill="${bg}"/>`;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const { ax, an } = colAnchors[i];
      const fill = c.color ? c.color(r) : '#334155';
      out += `<text x="${ax}" y="${y + opts.rowH - 10}" text-anchor="${an}" font-family='NotoSansSC' font-size="13" fill="${fill}">${esc(c.value(r))}</text>`;
    }
    y += opts.rowH;
  }
  return { svg: out, height: y };
}

function brandTable(brands: BannerBrandRow[]): { svg: string; height: number } {
  // 8 列（对齐 brand-metric-table.tsx），宽度和 1000
  const cols: ColSpec<BannerBrandRow>[] = [
    { label: '品牌', w: 120, align: 'left', value: (b) => b.name },
    { label: '销售目标', w: 130, align: 'right', value: (b) => b.saleTarget },
    { label: '销售金额', w: 130, align: 'right', value: (b) => b.saleAmount },
    { label: '销售完成率', w: 120, align: 'right', value: (b) => b.saleRate, color: (b) => rateColorHex(b.saleRateColor) },
    { label: '配送金额', w: 130, align: 'right', value: (b) => b.deliveryAmount },
    { label: '配销比', w: 90, align: 'right', value: (b) => b.deliveryRatio },
    { label: '配送毛利', w: 130, align: 'right', value: (b) => b.deliveryProfit },
    { label: '配送毛利率', w: 150, align: 'right', value: (b) => b.deliveryMargin, color: (b) => rateColorHex(b.marginColor) },
  ];
  return renderTable('品牌×指标', MX, cols, brands, {
    titleH: 34, headH: 30, rowH: BRAND_ROW_H,
    rowBg: (b) => (b.isTotal ? '#F8FAFC' : null),
  });
}

function regionTable(regions: BannerRegionRow[]): { svg: string; height: number } {
  // 13 列（对齐 region-drill-table.tsx），宽度和 1000
  const cols: ColSpec<BannerRegionRow>[] = [
    { label: '大区名称', w: 92, align: 'left', value: (r) => r.name },
    { label: '月销售目标', w: 70, align: 'right', value: (r) => r.saleTarget },
    { label: '月销售金额', w: 70, align: 'right', value: (r) => r.saleAmount },
    { label: '月销售完成率', w: 76, align: 'right', value: (r) => r.saleRate, color: (r) => rateColorHex(r.saleRateColor) },
    { label: '月配送目标', w: 70, align: 'right', value: (r) => r.deliveryTarget },
    { label: '月配送金额', w: 70, align: 'right', value: (r) => r.deliveryAmount },
    { label: '月配送完成率', w: 76, align: 'right', value: (r) => r.deliveryRate, color: (r) => rateColorHex(r.deliveryRateColor) },
    { label: '当天销售金额', w: 76, align: 'right', value: (r) => r.dailySale },
    { label: '当天配送金额', w: 76, align: 'right', value: (r) => r.dailyDelivery },
    { label: '剩余日均销售目标', w: 100, align: 'right', value: (r) => r.remainingDailySaleTarget },
    { label: '剩余日均配送目标', w: 100, align: 'right', value: (r) => r.remainingDailyDeliveryTarget },
    { label: '配销比目标', w: 62, align: 'right', value: (r) => r.ratioTarget, color: () => '#94A3B8' },
    { label: '配销比', w: 62, align: 'right', value: (r) => r.ratio, color: (r) => rateColorHex(r.ratioColor) },
  ];
  return renderTable('门店战区', MX, cols, regions, {
    titleH: 34, headH: 28, rowH: REGION_ROW_H,
  });
}

// 头部状态徽章（进行中=蓝底蓝字 / 已结束=灰底灰字），锚在目标名右侧
function headerBadge(status: 'active' | 'closed', x: number, y: number): string {
  const isActive = status === 'active';
  const { bg, text } = isActive ? { bg: '#EFF6FF', text: '#1D4ED8' } : { bg: '#F1F5F9', text: '#64748B' };
  const label = isActive ? '进行中' : '已结束';
  const w = 62, h = 26;
  return `
  <rect x="${x}" y="${y - h / 2}" width="${w}" height="${h}" rx="8" fill="${bg}"/>
  <text x="${x + w / 2}" y="${y + 4}" text-anchor="middle" font-family='NotoSansSC' font-size="13" fill="${text}">${esc(label)}</text>`;
}

export function renderReportBannerSvg(data: ReportBannerData): string {
  const target = data.target;
  const metaParts = [
    `${target.startDate} ~ ${target.endDate}`,
    `数据更新 ${target.dataUpdatedAt ?? '—'}`,
    `最近查询 ${target.lastQueryAt ?? '—'}`,
  ].join(' · ');

  // 高度按内容：头部 → KPI → 品牌表 → 战区表 → 底部边距；品牌/战区块 0 基准渲染后平移。
  const brand = brandTable(data.brands);
  const region = regionTable(data.regions);
  const regionTop = BRAND_TOP + brand.height + 18;
  const H = Math.max(MIN_H, regionTop + region.height + 24);

  // 徽章锚点：目标名宽度估算法（CJK ≈ 字号 px）+ 间距
  const nameW = [...target.name].length * 28;
  const badgeX = MX + nameW + 16;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${fontFace()}</defs>
  <rect width="${W}" height="${H}" fill="#FFFFFF"/>
  <text x="${MX}" y="${HEAD_TITLE_Y}" font-family='NotoSansSC' font-size="28" font-weight="600" fill="#0F172A">${esc(target.name)}</text>
  ${headerBadge(target.status, badgeX, HEAD_TITLE_Y - 8)}
  <text x="${MX}" y="${HEAD_META_Y}" font-family='NotoSansSC' font-size="14" fill="#64748B">${esc(metaParts)}</text>
  <line x1="${MX}" y1="${HEAD_DIV_Y}" x2="${W - MX}" y2="${HEAD_DIV_Y}" stroke="#E2E8F0" stroke-width="1"/>
  ${kpiCards(data.kpis)}
  <g transform="translate(0,${BRAND_TOP})">${brand.svg}</g>
  <g transform="translate(0,${regionTop})">${region.svg}</g>
</svg>
`;
}

export async function renderReportBannerPng(data: ReportBannerData): Promise<Buffer> {
  const svg = renderReportBannerSvg(data);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
