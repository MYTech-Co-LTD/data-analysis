import { describe, it, expect, vi } from 'vitest';
import {
  rateColor, rateColorHex, renderReportBannerSvg, renderReportBannerPng,
  type ReportBannerData,
} from '../banner-report';

const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({ png: () => ({ toBuffer: async () => Buffer.from('PNG') }) })),
}));
vi.mock('sharp', () => ({ default: sharpMock }));

const data: ReportBannerData = {
  date: '2026-08-21',
  kpis: [
    { metricCode: 'sale_amount', label: '销售额', value: '¥4,160,000', rate: '60.6%', rateColor: 'amber' },
    { metricCode: 'delivery_amount', label: '配送额', value: '¥1,200,000', rate: '88.0%', rateColor: 'amber' },
    { metricCode: 'outbound_amt', label: '出库额', value: '¥2,100,000', rate: '101.2%', rateColor: 'green' },
    { metricCode: 'outbound_profit', label: '出库毛利', value: '¥320,000', rate: '45.0%', rateColor: 'red' },
  ],
  brands: [
    { sbc: '3120', name: '熊喵鲜生', sale: '¥3,100,000', rate: '62.0%', rateColor: 'amber' },
    { sbc: '64188', name: '品品甜', sale: '¥1,060,000', rate: '55.0%', rateColor: 'red' },
    { sbc: '合计', name: '合计', sale: '¥4,160,000', rate: '60.6%', rateColor: 'amber' },
  ],
  regions: [
    { name: '东', sale: '¥1,400,000', rate: '72.0%', rateColor: 'amber' },
    { name: '南', sale: '¥1,100,000', rate: '65.0%', rateColor: 'amber' },
    { name: '西', sale: '¥980,000', rate: '58.0%', rateColor: 'red' },
    { name: '中', sale: '¥680,000', rate: '50.0%', rateColor: 'red' },
  ],
};

describe('rateColor 三色判定', () => {
  it('≥100 绿', () => { expect(rateColor(1.2)).toBe('green'); expect(rateColor(1)).toBe('green'); });
  it('≥60 琥珀', () => { expect(rateColor(0.9)).toBe('amber'); expect(rateColor(0.6)).toBe('amber'); });
  it('<60 红', () => { expect(rateColor(0.59)).toBe('red'); });
  it('null/undefined → 灰', () => { expect(rateColor(null)).toBe('gray'); expect(rateColor(undefined)).toBe('gray'); });
  it('rateColorHex 映射', () => {
    expect(rateColorHex('green')).toBe('#16A34A');
    expect(rateColorHex('amber')).toBe('#D97706');
    expect(rateColorHex('red')).toBe('#DC2626');
    expect(rateColorHex('gray')).toBe('#94A3B8');
  });
});

describe('renderReportBannerSvg', () => {
  it('含顶栏标题 + 日期', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).toContain('山海数据平台');
    expect(svg).toContain('2026-08-21');
  });
  it('含 4 个 KPI 标签与值、三色', () => {
    const svg = renderReportBannerSvg(data);
    for (const k of data.kpis) {
      expect(svg).toContain(k.label);
      expect(svg).toContain(k.value);
    }
    expect(svg).toContain('#16A34A'); // 出库 101.2% 绿
    expect(svg).toContain('#DC2626'); // 出库毛利 45% 红
  });
  it('含品牌 3 行与战区 4 行', () => {
    const svg = renderReportBannerSvg(data);
    for (const b of data.brands) expect(svg).toContain(b.name);
    for (const r of data.regions) expect(svg).toContain(r.name);
    expect(svg).toContain('品牌×指标');
    expect(svg).toContain('门店战区');
  });
  it('宽 1080 高 480 + @font-face 内嵌字体', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).toContain('width="1080"');
    expect(svg).toContain('height="480"');
    expect(svg).toContain('@font-face');
    expect(svg).toContain("font-family='NotoSansSC'");
  });
  it('空 KPI/战区 → 占位「暂无数据」不炸', () => {
    const svg = renderReportBannerSvg({ ...data, kpis: [], regions: [] });
    expect(svg).toContain('暂无数据');
  });
  it('文本转义（& < > "）', () => {
    const svg = renderReportBannerSvg({ ...data, brands: [{ sbc: 'x', name: 'A&B<C>', sale: '¥1', rate: '1%', rateColor: 'gray' }] });
    expect(svg).not.toContain('A&B<C>');
    expect(svg).toContain('A&amp;B&lt;C&gt;');
  });
});

describe('renderReportBannerPng', () => {
  it('sharp 渲染出 Buffer', async () => {
    const png = await renderReportBannerPng(data);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(sharpMock).toHaveBeenCalled();
  });
});
