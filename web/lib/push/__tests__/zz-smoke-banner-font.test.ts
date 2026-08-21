// 临时视觉冒烟：真实 sharp 渲染（不 mock），验证新字体子集能正常出 PNG（v2 白底横幅）。
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { renderReportBannerPng, type ReportBannerData } from '../banner-report';

const data: ReportBannerData = {
  target: {
    name: '6月经营目标',
    status: 'active',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    dataUpdatedAt: '2026-08-21 09:30',
    lastQueryAt: '2026-08-21 09:00',
  },
  kpis: [
    { metricCode: 'sale', label: '销售额', rate: '60.6%', rateColor: 'amber', subline: '416.0万/686.0万 · 进度 68%', status: 'partial' },
    { metricCode: 'delivery', label: '配送额', rate: '88.0%', rateColor: 'amber', subline: '120.0万/136.0万 · 进度 68%', status: 'complete' },
    { metricCode: 'outbound_amt', label: '出库额', rate: '101.2%', rateColor: 'green', subline: '210.0万/208.0万 · 进度 68%', status: 'complete' },
    { metricCode: 'outbound_profit', label: '出库毛利', rate: '45.0%', rateColor: 'red', subline: '32.0万/71.0万 · 进度 68%', status: 'missing' },
    { metricCode: 'delivery_sale_ratio', label: '总配销比', rate: '29%', rateColor: 'slate', subline: '配送120.0万/销售416.0万', status: null },
    { metricCode: 'outbound_margin', label: '毛利率', rate: '15.2%', rateColor: 'green', subline: '毛利32.0万/出库210.0万 · 目标 12%', status: null },
  ],
  brands: [
    { sbc: '3120', name: '熊喵鲜生', saleTarget: '¥500.0万', saleAmount: '¥310.0万', saleRate: '62.0%', saleRateColor: 'amber', deliveryAmount: '¥90.0万', deliveryRatio: '29%', deliveryProfit: '¥12.0万', deliveryMargin: '13.3%', marginColor: 'green', isTotal: false },
    { sbc: '64188', name: '品品甜', saleTarget: '¥186.0万', saleAmount: '¥106.0万', saleRate: '57.0%', saleRateColor: 'red', deliveryAmount: '¥30.0万', deliveryRatio: '28%', deliveryProfit: '¥3.0万', deliveryMargin: '10.0%', marginColor: 'amber', isTotal: false },
    { sbc: '合计', name: '合计', saleTarget: '¥686.0万', saleAmount: '¥416.0万', saleRate: '60.6%', saleRateColor: 'amber', deliveryAmount: '¥120.0万', deliveryRatio: '29%', deliveryProfit: '¥15.0万', deliveryMargin: '12.5%', marginColor: 'green', isTotal: true },
  ],
  regions: [
    { name: '东部战区', saleTarget: '¥200.0万', saleAmount: '¥144.0万', saleRate: '72.0%', saleRateColor: 'amber', deliveryTarget: '¥60.0万', deliveryAmount: '¥30.0万', deliveryRate: '50.0%', deliveryRateColor: 'red', dailySale: '¥4.8万', dailyDelivery: '¥1.0万', remainingDailySaleTarget: '¥2.0万', remainingDailyDeliveryTarget: '¥1.0万', ratioTarget: '30%', ratio: '21%', ratioColor: 'red' },
    { name: '南部战区', saleTarget: '¥170.0万', saleAmount: '¥110.0万', saleRate: '65.0%', saleRateColor: 'amber', deliveryTarget: '¥50.0万', deliveryAmount: '¥20.0万', deliveryRate: '40.0%', deliveryRateColor: 'red', dailySale: '¥3.7万', dailyDelivery: '¥0.7万', remainingDailySaleTarget: '¥2.0万', remainingDailyDeliveryTarget: '¥1.0万', ratioTarget: '29%', ratio: '18%', ratioColor: 'red' },
    { name: '西部战区', saleTarget: '¥160.0万', saleAmount: '¥98.0万', saleRate: '61.0%', saleRateColor: 'amber', deliveryTarget: '¥50.0万', deliveryAmount: '¥20.0万', deliveryRate: '40.0%', deliveryRateColor: 'red', dailySale: '¥3.3万', dailyDelivery: '¥0.7万', remainingDailySaleTarget: '¥2.1万', remainingDailyDeliveryTarget: '¥1.0万', ratioTarget: '31%', ratio: '20%', ratioColor: 'red' },
    { name: '中部战区', saleTarget: '¥150.0万', saleAmount: '¥64.0万', saleRate: '42.7%', saleRateColor: 'red', deliveryTarget: '¥50.0万', deliveryAmount: '¥10.0万', deliveryRate: '20.0%', deliveryRateColor: 'red', dailySale: '¥2.1万', dailyDelivery: '¥0.3万', remainingDailySaleTarget: '¥2.9万', remainingDailyDeliveryTarget: '¥1.6万', ratioTarget: '33%', ratio: '16%', ratioColor: 'red' },
  ],
};

describe('banner font smoke', () => {
  it('真实 sharp 渲染 v2 白底 PNG 到 /tmp', async () => {
    const png = await renderReportBannerPng(data);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
    writeFileSync('/tmp/report-banner-v2.png', png);
    console.log('PNG bytes:', png.length);
  });
});
