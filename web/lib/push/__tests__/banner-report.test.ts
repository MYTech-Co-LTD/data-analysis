import { describe, it, expect, vi } from 'vitest';
import {
  achievementColor, rateColorHex, marginColor, renderReportBannerSvg, renderReportBannerPng,
  type ReportBannerData,
} from '../banner-report';

const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({ png: () => ({ toBuffer: async () => Buffer.from('PNG') }) })),
}));
vi.mock('sharp', () => ({ default: sharpMock }));

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
    // 4 金额卡：达成率大字 + 实际/目标/进度 + 状态徽章
    { metricCode: 'sale', label: '销售额', rate: '60.6%', rateColor: 'amber', subline: '416万/686万 · 进度 68%', status: 'partial' },
    { metricCode: 'delivery', label: '配送额', rate: '88.0%', rateColor: 'amber', subline: '120万/136万 · 进度 68%', status: 'complete' },
    { metricCode: 'outbound_amt', label: '出库额', rate: '101.2%', rateColor: 'green', subline: '210万/208万 · 进度 68%', status: 'complete' },
    { metricCode: 'outbound_profit', label: '出库毛利', rate: '45.0%', rateColor: 'red', subline: '32万/71万 · 进度 68%', status: 'missing' },
    // 2 比率卡：总配销比（无三色，中性深色）+ 毛利率（绝对三色，目标 12%）
    { metricCode: 'delivery_sale_ratio', label: '总配销比', rate: '28.8%', rateColor: 'slate', subline: '配送120万/销售416万', status: null },
    { metricCode: 'outbound_margin', label: '毛利率', rate: '15.2%', rateColor: 'green', subline: '毛利32万/出库210万 · 目标 12%', status: null },
  ],
  brands: [
    { sbc: '3120', name: '熊喵鲜生', saleTarget: '¥500万', saleAmount: '¥310万', saleRate: '62.0%', saleRateColor: 'amber',
      deliveryAmount: '¥90万', deliveryRatio: '29.0%', deliveryProfit: '¥12万', deliveryMargin: '13.3%', marginColor: 'green', isTotal: false },
    { sbc: '64188', name: '品品甜', saleTarget: '¥186万', saleAmount: '¥106万', saleRate: '57.0%', saleRateColor: 'red',
      deliveryAmount: '¥30万', deliveryRatio: '28.3%', deliveryProfit: '¥3万', deliveryMargin: '10.0%', marginColor: 'amber', isTotal: false },
    { sbc: '合计', name: '合计', saleTarget: '¥686万', saleAmount: '¥416万', saleRate: '60.6%', saleRateColor: 'amber',
      deliveryAmount: '¥120万', deliveryRatio: '28.8%', deliveryProfit: '¥15万', deliveryMargin: '12.5%', marginColor: 'green', isTotal: true },
  ],
  regions: [
    { name: '东部战区', saleTarget: '¥200万', saleAmount: '¥144万', saleRate: '72.0%', saleRateColor: 'amber',
      deliveryTarget: '¥60万', deliveryAmount: '¥30万', deliveryRate: '50.0%', deliveryRateColor: 'red',
      dailySale: '¥4.8万', dailyDelivery: '¥1.0万', remainingDailySaleTarget: '¥2.0万', remainingDailyDeliveryTarget: '¥1.0万',
      ratioTarget: '30.0%', ratio: '20.8%', ratioColor: 'red' },
    { name: '南部战区', saleTarget: '¥170万', saleAmount: '¥110万', saleRate: '65.0%', saleRateColor: 'amber',
      deliveryTarget: '¥50万', deliveryAmount: '¥20万', deliveryRate: '40.0%', deliveryRateColor: 'red',
      dailySale: '¥3.7万', dailyDelivery: '¥0.7万', remainingDailySaleTarget: '¥2.0万', remainingDailyDeliveryTarget: '¥1.0万',
      ratioTarget: '29.4%', ratio: '18.2%', ratioColor: 'red' },
    { name: '西部战区', saleTarget: '¥160万', saleAmount: '¥98万', saleRate: '61.0%', saleRateColor: 'amber',
      deliveryTarget: '¥50万', deliveryAmount: '¥20万', deliveryRate: '40.0%', deliveryRateColor: 'red',
      dailySale: '¥3.3万', dailyDelivery: '¥0.7万', remainingDailySaleTarget: '¥2.1万', remainingDailyDeliveryTarget: '¥1.0万',
      ratioTarget: '31.3%', ratio: '20.4%', ratioColor: 'red' },
    { name: '中部战区', saleTarget: '¥150万', saleAmount: '¥64万', saleRate: '42.7%', saleRateColor: 'red',
      deliveryTarget: '¥50万', deliveryAmount: '¥10万', deliveryRate: '20.0%', deliveryRateColor: 'red',
      dailySale: '¥2.1万', dailyDelivery: '¥0.3万', remainingDailySaleTarget: '¥2.9万', remainingDailyDeliveryTarget: '¥1.6万',
      ratioTarget: '33.3%', ratio: '15.6%', ratioColor: 'red' },
  ],
};

describe('achievementColor 相对进度三色判定', () => {
  it('≥1（跑赢进度）绿', () => { expect(achievementColor(1.2, 1)).toBe('green'); expect(achievementColor(1, 1)).toBe('green'); });
  it('≥0.8 琥珀', () => { expect(achievementColor(0.9, 1)).toBe('amber'); expect(achievementColor(0.8, 1)).toBe('amber'); });
  it('<0.8 红', () => { expect(achievementColor(0.79, 1)).toBe('red'); expect(achievementColor(0.59, 1)).toBe('red'); });
  it('相对进度：rate/progress 归一化（相同 rate 不同 progress → 颜色不同）', () => {
    expect(achievementColor(0.6, 0.5)).toBe('green');   // 0.6/0.5 = 1.2 ≥ 1
    expect(achievementColor(0.6, 0.8)).toBe('red');     // 0.6/0.8 = 0.75 < 0.8
    expect(achievementColor(0.7, 0.8)).toBe('amber');   // 0.7/0.8 = 0.875 ≥ 0.8
  });
  it('progress=0 → 除 0.0001 兜底；progress null → 绝对达成率', () => {
    expect(achievementColor(1.2, 0)).toBe('green');     // 1.2/0.0001 大数
    expect(achievementColor(0.6, null)).toBe('red');    // 绝对: 0.6 < 0.8
  });
  it('null/undefined/NaN → 灰', () => {
    expect(achievementColor(null, 1)).toBe('gray');
    expect(achievementColor(undefined, 1)).toBe('gray');
    expect(achievementColor(Number.NaN, 1)).toBe('gray');
  });
  it('rateColorHex 映射（三色 + 灰 + 中性深色）', () => {
    expect(rateColorHex('green')).toBe('#16A34A');
    expect(rateColorHex('amber')).toBe('#D97706');
    expect(rateColorHex('red')).toBe('#DC2626');
    expect(rateColorHex('gray')).toBe('#94A3B8');
    expect(rateColorHex('slate')).toBe('#1E293B');
  });
});

describe('marginColor 毛利率绝对三色（目标 12%）', () => {
  it('≥12% 绿 / ≥9.6% 琥珀 / <9.6% 红', () => {
    expect(marginColor(0.12)).toBe('green');
    expect(marginColor(0.15)).toBe('green');
    expect(marginColor(0.096)).toBe('amber');
    expect(marginColor(0.1)).toBe('amber');
    expect(marginColor(0.095)).toBe('red');
  });
  it('null/NaN → 灰（成本脱敏）', () => {
    expect(marginColor(null)).toBe('gray');
    expect(marginColor(Number.NaN)).toBe('gray');
  });
});

describe('renderReportBannerSvg', () => {
  it('白底：无深蓝渐变 #0F2557 / #1E40AF', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).not.toContain('#0F2557');
    expect(svg).not.toContain('#1E40AF');
    expect(svg).not.toContain('linearGradient');
    expect(svg).toContain('fill="#FFFFFF"');
  });
  it('头部：数据截止：yyyy-mm-dd hh:mm（dataUpdatedAt 优先，退化 startDate）', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).toContain('数据截止：2026-08-21 09:30');
    // 不再渲染目标名/状态徽章/日期区间
    expect(svg).not.toContain('6月经营目标');
    expect(svg).not.toContain('进行中');
  });
  it('dataUpdatedAt 缺失 → 数据截止退化 startDate', () => {
    const svg = renderReportBannerSvg({ ...data, target: { ...data.target, dataUpdatedAt: null, lastQueryAt: null } });
    expect(svg).toContain('数据截止：2026-06-01');
  });
  it('KPI 卡：4 金额卡标签 + 2 比率卡标签 + 达成率大字 + 小字副行（截断不超卡宽；无右上角状态徽章）', () => {
    const svg = renderReportBannerSvg(data);
    for (const k of data.kpis) {
      expect(svg).toContain(k.label);
      expect(svg).toContain(k.rate);       // 达成率/比率大字
    }
    // 副行截断到 ≤maxLen（避免超卡宽出框）
    expect(svg).toContain('…');
    // 右上角状态徽章（部分/已完成/缺失）不再渲染
    expect(svg).not.toContain('已完成');
    expect(svg).not.toContain('缺失');
  });
  it('KPI 三色：相对进度绿 + 毛利率绝对三色 + 中性深色（总配销比）', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).toContain('#16A34A'); // 出库 101.2% 绿 + 毛利率 15.2% 绿
    expect(svg).toContain('#DC2626'); // 出库毛利 45% 红
    expect(svg).toContain('#1E293B'); // 总配销比中性深色
    expect(svg).toContain('#D97706'); // 销售 60.6% 琥珀
  });
  it('品牌表 8 列表头（与报表中心 brand-metric-table 一致）', () => {
    const svg = renderReportBannerSvg(data);
    for (const h of ['品牌', '销售目标', '销售金额', '销售完成率', '配送金额', '配销比', '配送毛利', '配送毛利率']) {
      expect(svg).toContain(h);
    }
    for (const b of data.brands) {
      expect(svg).toContain(b.name);
      expect(svg).toContain(b.saleAmount);
    }
  });
  it('战区表 13 列表头（与报表中心 region-drill-table 一致）', () => {
    const svg = renderReportBannerSvg(data);
    for (const h of ['大区名称', '月销售目标', '月销售金额', '月销售完成率', '月配送目标', '月配送金额', '月配送完成率',
      '当天销售金额', '当天配送金额', '剩余日均销售目标', '剩余日均配送目标', '配销比目标', '配销比']) {
      expect(svg).toContain(h);
    }
    for (const r of data.regions) expect(svg).toContain(r.name);
  });
  it('cost 隐藏 → 配送毛利/配送毛利率显示「—」且灰色', () => {
    const svg = renderReportBannerSvg({
      ...data,
      brands: data.brands.map((b) => ({ ...b, deliveryProfit: '—', deliveryMargin: '—', marginColor: 'gray' as const })),
    });
    expect(svg).toContain('—');
  });
  it('宽度 1080 + 高度按内容 ≤830 + aspect ≥1.3 + @font-face 内嵌字体', () => {
    const svg = renderReportBannerSvg(data);
    expect(svg).toContain('width="1080"');
    const h = Number(svg.match(/height="(\d+)"/)![1]);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(830);
    expect(1080 / h).toBeGreaterThanOrEqual(1.3);
    expect(svg).toContain('@font-face');
    expect(svg).toContain("font-family='NotoSansSC'");
  });
  it('空 KPI/品牌/战区 → 占位「暂无数据」不炸', () => {
    const svg = renderReportBannerSvg({ ...data, kpis: [], brands: [], regions: [] });
    expect(svg).toContain('暂无数据');
  });
  it('文本转义（& < > "）', () => {
    const svg = renderReportBannerSvg({
      ...data,
      brands: [{ ...data.brands[0], name: 'X&Y<Z>"W' }],
    });
    expect(svg).not.toContain('X&Y<Z>');
    expect(svg).toContain('X&amp;Y&lt;Z&gt;&quot;W');
  });
});

describe('renderReportBannerPng', () => {
  it('sharp 渲染出 Buffer', async () => {
    const png = await renderReportBannerPng(data);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(sharpMock).toHaveBeenCalled();
  });
});
