// 报表数据横幅 SVG/PNG 渲染（架构 §7.4 2026-08-21；spec docs/superpowers/specs/2026-08-21-push-banner-report-design.md）：
//   KPI 4 卡（销售额/配送额/出库额/出库毛利）+ 品牌 3 行 + 战区 4 行，1080×480 aspect 2.25。
//   深蓝渐变 + slate 中性 + 达成三色 + tabular-nums，样式参考报表页不 1:1 复刻。
//   纯函数可单测；sharp 在 renderReportBannerPng（无进程内缓存——对象存储即缓存）。
import sharp from 'sharp';
import { BANNER_FONT_BASE64 } from './banner-font';

export type RateColor = 'green' | 'amber' | 'red' | 'gray';

export function rateColor(rate: number | null | undefined): RateColor {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return 'gray';
  if (rate >= 1) return 'green';
  if (rate >= 0.6) return 'amber';
  return 'red';
}

export function rateColorHex(c: RateColor): string {
  switch (c) {
    case 'green': return '#16A34A';
    case 'amber': return '#D97706';
    case 'red': return '#DC2626';
    default: return '#94A3B8';
  }
}

export interface BannerKpiCard {
  metricCode: string; label: string; value: string; rate: string; rateColor: RateColor;
}
export interface BannerBrandRow {
  sbc: string; name: string; sale: string; rate: string; rateColor: RateColor;
}
export interface BannerRegionRow {
  name: string; sale: string; rate: string; rateColor: RateColor;
}
export interface ReportBannerData {
  date: string;
  kpis: BannerKpiCard[];
  brands: BannerBrandRow[];
  regions: BannerRegionRow[];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 布局常量（1080×480）
const W = 1080;
const H = 480;

// KPI 卡：4 卡横排，x 起 40，卡宽 244，间距 12 → 40+244*4+12*3 = 1060 ≤ 1080
const KPI_X0 = 40, KPI_W = 244, KPI_GAP = 12;
const KPI_Y0 = 108, KPI_H = 148;

// 底部两栏：左=品牌（x 40-532），右=战区（x 548-1040）
const BRAND_X = 56, REGION_X = 548, COL_W = 472, COL_Y0 = 296, COL_H = 172;

function fontFace(): string {
  return `<style>@font-face{font-family:'NotoSansSC';src:url(data:application/font-otf;charset=utf-8;base64,${BANNER_FONT_BASE64}) format('opentype');}</style>`;
}

function kpiCard(k: BannerKpiCard, i: number): string {
  const x = KPI_X0 + i * (KPI_W + KPI_GAP);
  return `
  <rect x="${x}" y="${KPI_Y0}" width="${KPI_W}" height="${KPI_H}" rx="10" fill="#FFFFFF" fill-opacity="0.06"/>
  <text x="${x + 18}" y="${KPI_Y0 + 34}" font-family='NotoSansSC' font-size="24" fill="#CBD5E1">${esc(k.label)}</text>
  <text x="${x + 18}" y="${KPI_Y0 + 88}" font-family='NotoSansSC' font-size="42" fill="#FFFFFF">${esc(k.value)}</text>
  <text x="${x + 18}" y="${KPI_Y0 + 124}" font-family='NotoSansSC' font-size="26" fill="${rateColorHex(k.rateColor)}">达成率 ${esc(k.rate)}</text>`;
}

function brandRows(brands: BannerBrandRow[]): string {
  if (brands.length === 0) return `<text x="${BRAND_X}" y="${COL_Y0 + 60}" font-family='NotoSansSC' font-size="26" fill="#94A3B8">暂无数据</text>`;
  return brands.map((b, i) => {
    const y = COL_Y0 + 34 + i * 34;
    return `
  <text x="${BRAND_X}" y="${y}" font-family='NotoSansSC' font-size="24" fill="#E2E8F0">${esc(b.name)}</text>
  <text x="${BRAND_X + 170}" y="${y}" font-family='NotoSansSC' font-size="24" fill="#FFFFFF">${esc(b.sale)}</text>
  <text x="${BRAND_X + 400}" y="${y}" font-family='NotoSansSC' font-size="24" fill="${rateColorHex(b.rateColor)}" text-anchor="end">${esc(b.rate)}</text>`;
  }).join('');
}

function regionRows(regions: BannerRegionRow[]): string {
  if (regions.length === 0) return `<text x="${REGION_X}" y="${COL_Y0 + 60}" font-family='NotoSansSC' font-size="26" fill="#94A3B8">暂无数据</text>`;
  return regions.map((r, i) => {
    const y = COL_Y0 + 28 + i * 28;
    return `
  <text x="${REGION_X}" y="${y}" font-family='NotoSansSC' font-size="22" fill="#E2E8F0">${esc(r.name)}</text>
  <text x="${REGION_X + 90}" y="${y}" font-family='NotoSansSC' font-size="22" fill="#FFFFFF">${esc(r.sale)}</text>
  <text x="${REGION_X + 460}" y="${y}" font-family='NotoSansSC' font-size="22" fill="${rateColorHex(r.rateColor)}" text-anchor="end">${esc(r.rate)}</text>`;
  }).join('');
}

export function renderReportBannerSvg(data: ReportBannerData): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1E40AF"/>
      <stop offset="1" stop-color="#0F2557"/>
    </linearGradient>
    ${fontFace()}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <text x="56" y="72" font-family='NotoSansSC' font-size="32" fill="#94A3B8">山海数据平台</text>
  <text x="${W - 56}" y="72" font-family='NotoSansSC' font-size="32" fill="#94A3B8" text-anchor="end">${esc(data.date)}</text>
  <line x1="40" y1="96" x2="${W - 40}" y2="96" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="2"/>
  ${data.kpis.map(kpiCard).join('')}
  <text x="${BRAND_X}" y="${COL_Y0 - 12}" font-family='NotoSansSC' font-size="26" fill="#93C5FD">品牌×指标</text>
  ${brandRows(data.brands)}
  <text x="${REGION_X}" y="${COL_Y0 - 12}" font-family='NotoSansSC' font-size="26" fill="#93C5FD">门店战区</text>
  ${regionRows(data.regions)}
</svg>
`;
}

export async function renderReportBannerPng(data: ReportBannerData): Promise<Buffer> {
  const svg = renderReportBannerSvg(data);
  return sharp(Buffer.from(svg)).png().toBuffer();
}
