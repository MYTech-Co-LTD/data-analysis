// 临时视觉冒烟：真实 sharp 渲染（不 mock），验证新字体子集能正常出 PNG。
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { renderReportBannerPng, type ReportBannerData } from '../banner-report';

const data: ReportBannerData = {
  date: '2026-08-21',
  kpis: [
    { metricCode: 'sale', label: '销售额', value: '¥4,160,000', rate: '60.6%', rateColor: 'amber' },
    { metricCode: 'delivery', label: '配送额', value: '¥1,200,000', rate: '88.0%', rateColor: 'amber' },
    { metricCode: 'outbound_amt', label: '出库额', value: '¥2,100,000', rate: '101.2%', rateColor: 'green' },
    { metricCode: 'outbound_profit', label: '出库毛利', value: '¥320,000', rate: '45.0%', rateColor: 'red' },
  ],
  brands: [
    { sbc: '3120', name: '熊喵鲜生', sale: '¥3,100,000', rate: '62.0%', rateColor: 'amber' },
    { sbc: '64188', name: '品品甜', sale: '¥1,060,000', rate: '55.0%', rateColor: 'red' },
    { sbc: '合计', name: '合计', sale: '¥4,160,000', rate: '60.6%', rateColor: 'amber' },
  ],
  regions: [
    { name: '东部战区', sale: '¥1,400,000', rate: '72.0%', rateColor: 'amber' },
    { name: '南部战区', sale: '¥1,100,000', rate: '65.0%', rateColor: 'amber' },
    { name: '西部战区', sale: '¥980,000', rate: '58.0%', rateColor: 'red' },
    { name: '中部战区', sale: '¥680,000', rate: '50.0%', rateColor: 'red' },
  ],
};

describe('banner font smoke', () => {
  it('真实 sharp 渲染 1080×480 PNG 到 /tmp', async () => {
    const png = await renderReportBannerPng(data);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
    writeFileSync('/tmp/report-banner.png', png);
    console.log('PNG bytes:', png.length);
  });
});
