import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  templateRefersReportBanner, signBannerObject, verifyBannerObject, bannerExpiresAt,
  resolveReportBannerData, buildReportBannerUrl, REPORT_BANNER_VAR, REPORT_BANNER_TOKEN, BANNER_URL_TTL_MS,
} from '../banner-report-resolve';

vi.stubEnv('JWT_SECRET', 'test-secret-0123456789abcdef');
vi.stubEnv('PUSH_BRIDGE_BASE_URL', 'https://data.shanhaiyiguo.com/api/wecom-bridge');
vi.stubEnv('POSTGREST_URL', 'http://postgrest:3000');

// mock sharp（resolve→render 全链路）
const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({ png: () => ({ toBuffer: async () => Buffer.from('PNG') }) })),
}));
vi.mock('sharp', () => ({ default: sharpMock }));

// mock 全局 fetch（PostgREST 视图 + targets + freshness RPC + 不真发 S3）
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

// 视图行数据（metric_code 为视图真码——report_achievement_gen 输出 mv.metric_code：
//   sale/delivery/outbound_amt/outbound_profit；progress_rate/data_status 同视图列）
// 视图还含 name/status/start_date/end_date（total 级 RLS 放行）——resolve 从 KPI 首行派生头部 target 信息。
const kpiRows = [
  { target_id: 42, name: '6月经营目标', status: 'active', start_date: '2026-06-01', end_date: '2026-06-30', metric_code: 'sale', target_value: 6860000, actual_value: 4160000, achievement_rate: 0.606, progress_rate: 0.68, data_status: 'partial' },
  { target_id: 42, name: '6月经营目标', status: 'active', start_date: '2026-06-01', end_date: '2026-06-30', metric_code: 'delivery', target_value: 1360000, actual_value: 1200000, achievement_rate: 0.88, progress_rate: 0.68, data_status: 'complete' },
  { target_id: 42, name: '6月经营目标', status: 'active', start_date: '2026-06-01', end_date: '2026-06-30', metric_code: 'outbound_amt', target_value: 2080000, actual_value: 2100000, achievement_rate: 1.012, progress_rate: 0.68, data_status: 'complete' },
  { target_id: 42, name: '6月经营目标', status: 'active', start_date: '2026-06-01', end_date: '2026-06-30', metric_code: 'outbound_profit', target_value: 710000, actual_value: 320000, achievement_rate: 0.45, progress_rate: 0.68, data_status: 'missing' },
];
const brandRows = [
  { system_book_code: '3120', brand_name: '熊喵鲜生', sale_target: 5000000, sale_amount: 3100000, sale_rate: 0.62, delivery_amount: 900000, delivery_profit: 120000, delivery_margin: 0.133 },
  { system_book_code: '64188', brand_name: '品品甜', sale_target: 1860000, sale_amount: 1060000, sale_rate: 0.57, delivery_amount: 300000, delivery_profit: 30000, delivery_margin: 0.1 },
  { system_book_code: '合计', brand_name: '合计', sale_target: 6860000, sale_amount: 4160000, sale_rate: 0.606, delivery_amount: 1200000, delivery_profit: 150000, delivery_margin: 0.125 },
];
const regionRows = [
  { region_name: '东部战区', sale_target: 2000000, sale_actual: 1440000, sale_rate: 0.72, delivery_target: 600000, delivery_actual: 300000, delivery_rate: 0.5, daily_sale: 48000, daily_delivery: 10000, remaining_daily_sale_target: 20000, remaining_daily_delivery_target: 10000 },
  { region_name: '南部战区', sale_target: 1700000, sale_actual: 1100000, sale_rate: 0.65, delivery_target: 500000, delivery_actual: 200000, delivery_rate: 0.4, daily_sale: 37000, daily_delivery: 7000, remaining_daily_sale_target: 20000, remaining_daily_delivery_target: 10000 },
  { region_name: '西部战区', sale_target: 1600000, sale_actual: 980000, sale_rate: 0.61, delivery_target: 500000, delivery_actual: 200000, delivery_rate: 0.4, daily_sale: 33000, daily_delivery: 7000, remaining_daily_sale_target: 21000, remaining_daily_delivery_target: 10000 },
  { region_name: '中部战区', sale_target: 1500000, sale_actual: 640000, sale_rate: 0.427, delivery_target: 500000, delivery_actual: 100000, delivery_rate: 0.2, daily_sale: 21000, daily_delivery: 3000, remaining_daily_sale_target: 29000, remaining_daily_delivery_target: 16000 },
];
const targetRow = { id: 42, name: '6月经营目标', status: 'active', start_date: '2026-06-01', end_date: '2026-06-30' };
const freshnessRow = { data_updated_at: '2026-08-21T01:30:00+00:00', last_query_at: '2026-08-21T01:00:00+00:00' };

function mockViews(opts: {
  kpi?: typeof kpiRows; brand?: Array<Record<string, unknown>>; region?: typeof regionRows;
  target?: typeof targetRow | null; freshness?: typeof freshnessRow | null;
  noTargetId?: boolean;
} = {}) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    const body = init?.body ? String(init.body) : '';
    if (u.includes('/report_achievement_gen')) {
      const rows = opts.kpi ?? kpiRows;
      return jsonResp(opts.noTargetId ? rows.map((r) => {
        const { target_id, ...rest } = r; void target_id; return rest;
      }) : rows);
    }
    if (u.includes('/report_brand_metric_gen')) return jsonResp(opts.brand ?? brandRows);
    if (u.includes('/report_region_breakdown_gen')) return jsonResp(opts.region ?? regionRows);
    if (u.includes('/targets?')) {
      return jsonResp(opts.target === null ? [] : [opts.target ?? targetRow]);
    }
    if (u.includes('/rpc/get_data_freshness')) {
      return jsonResp(opts.freshness === null ? [] : [opts.freshness ?? freshnessRow]);
    }
    return jsonResp([]);
  });
}
function jsonResp(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe('templateRefersReportBanner', () => {
  it('card_json 深度含 {{report_banner}} → true', () => {
    expect(REPORT_BANNER_VAR).toBe('report_banner'); // 变量注册名与 token 内名一致（Task 5 preset 消费）
    expect(templateRefersReportBanner({ card_image: { url: REPORT_BANNER_TOKEN } })).toBe(true);
    expect(templateRefersReportBanner({ card_image: { url: '{{report_banner}}' } })).toBe(true);
  });
  it('不含 / 非对象 → false', () => {
    expect(templateRefersReportBanner({ card_image: { url: 'https://x/y.png' } })).toBe(false);
    expect(templateRefersReportBanner(null)).toBe(false);
    expect(templateRefersReportBanner(undefined)).toBe(false);
    expect(templateRefersReportBanner('{{report_banner}}')).toBe(false); // 非对象
  });
});

describe('signBannerObject/verifyBannerObject', () => {
  it('正确签名验过，篡改/错过期 → false', () => {
    const exp = 1756000000;
    const sig = signBannerObject('abc', exp);
    expect(verifyBannerObject('abc', exp, sig)).toBe(true);
    expect(verifyBannerObject('abc', exp + 1, sig)).toBe(false);
    expect(verifyBannerObject('abc', exp, signBannerObject('abc', exp + 1))).toBe(false);
    expect(verifyBannerObject('abd', exp, sig)).toBe(false);
    expect(verifyBannerObject('abc', exp, '')).toBe(false);
    expect(verifyBannerObject('abc', exp, 'not-a-sig')).toBe(false);
  });
  it('bannerExpiresAt = now + TTL', () => {
    expect(bannerExpiresAt(1000)).toBe(1000 + BANNER_URL_TTL_MS);
  });
});

describe('resolveReportBannerData', () => {
  beforeEach(() => mockViews({}));

  it('follow 模式：查 3 视图 + targets + freshness → KPI 6 卡（4 金额 + 2 比率）/品牌 8 列/战区 13 列/头部', async () => {
    const data = await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'follow' });
    expect(data).not.toBeNull();
    const d = data!;
    // 头部
    expect(d.target.name).toBe('6月经营目标');
    expect(d.target.status).toBe('active');
    expect(d.target.startDate).toBe('2026-06-01');
    expect(d.target.endDate).toBe('2026-06-30');
    expect(d.target.dataUpdatedAt).toBe('2026-08-21 09:30'); // UTC → Asia/Shanghai 格式化
    expect(d.target.lastQueryAt).toBe('2026-08-21 09:00');
    // KPI 6 卡：4 金额 + 2 比率
    expect(d.kpis).toHaveLength(6);
    expect(d.kpis.map((k) => k.metricCode)).toEqual([
      'sale', 'delivery', 'outbound_amt', 'outbound_profit', 'delivery_sale_ratio', 'outbound_margin',
    ]);
    // 金额卡：达成率 + 相对进度三色 + 副行（fmtWan 实际/目标 · 进度）+ 状态徽章
    const sale = d.kpis[0];
    expect(sale.label).toBe('销售额');
    expect(sale.rate).toBe('60.6%');
    expect(sale.subline).toBe('416.0万/686.0万 · 进度 68%'); // fmtWan：≥1万 → (v/10000).toFixed(1)万
    expect(sale.rateColor).toBe('amber'); // 0.606/0.68 = 0.89 ≥ 0.8
    expect(sale.status).toBe('partial');
    const outbound = d.kpis[2];
    expect(outbound.rateColor).toBe('green'); // 1.012/0.68 = 1.49 ≥ 1
    expect(outbound.status).toBe('complete');
    // 比率卡：总配销比（中性）+ 毛利率（绝对三色）
    const ratio = d.kpis[4];
    expect(ratio.label).toBe('总配销比');
    expect(ratio.rate).toBe('29%'); // 1200000/4160000 → formatRatio 0 位小数
    expect(ratio.rateColor).toBe('slate');
    expect(ratio.subline).toContain('120.0万');
    const margin = d.kpis[5];
    expect(margin.label).toBe('毛利率');
    expect(margin.rate).toBe('15.2%'); // 320000/2100000
    expect(margin.rateColor).toBe('green'); // 0.152/0.12 = 1.27 ≥ 1
    expect(margin.subline).toContain('目标 12%');
    expect(ratio.status).toBeNull();
    expect(margin.status).toBeNull();
    // 品牌 8 列
    expect(d.brands.map((b) => b.sbc)).toEqual(['3120', '64188', '合计']);
    const b0 = d.brands[0];
    expect(b0.name).toBe('熊喵鲜生');
    expect(b0.saleTarget).toBe('¥500.0万');
    expect(b0.saleAmount).toBe('¥310.0万');
    expect(b0.saleRate).toBe('62.0%');
    expect(b0.deliveryAmount).toBe('¥90.0万');
    expect(b0.deliveryRatio).toBe('29%'); // 900000/3100000 → formatRatio 0 位小数
    expect(b0.deliveryProfit).toBe('¥12.0万');
    expect(b0.deliveryMargin).toBe('13.3%');
    expect(b0.marginColor).toBe('green'); // 0.133/0.12
    // 战区 13 列
    expect(d.regions.map((r) => r.name)).toEqual(['东部战区', '南部战区', '西部战区', '中部战区']);
    const r0 = d.regions[0];
    expect(r0.saleTarget).toBe('¥200.0万');
    expect(r0.saleRate).toBe('72.0%');
    expect(r0.saleRateColor).toBe('green'); // 0.72/0.68 = 1.06 ≥ 1
    expect(r0.deliveryTarget).toBe('¥60.0万');
    expect(r0.deliveryRate).toBe('50.0%');
    expect(r0.dailySale).toBe('¥4.8万');
    expect(r0.remainingDailySaleTarget).toBe('¥2.0万');
    expect(r0.ratioTarget).toBe('30%'); // 600000/2000000 → formatRatio 0 位小数
    expect(r0.ratio).toBe('21%'); // 300000/1440000 → 0.2083
  });

  it('follow 查询：KPI 含 status=active + 日期窗 + progress_rate/data_status；brand/region 扩展 select；targets + freshness RPC', async () => {
    await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'follow' });
    const findCall = (path: string) => fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes(path));
    const kpiUrl = String(findCall('report_achievement_gen')![0]);
    expect(kpiUrl).toContain('status=eq.active');
    expect(kpiUrl).toContain('start_date=lte.');
    expect(kpiUrl).toContain('end_date=gte.');
    expect(kpiUrl).not.toContain('limit=');
    expect(kpiUrl).toContain('progress_rate');
    expect(kpiUrl).toContain('data_status');
    const brandUrl = String(findCall('report_brand_metric_gen')![0]);
    expect(brandUrl).toContain('target_id=eq.42');
    for (const col of ['sale_target', 'sale_amount', 'sale_rate', 'delivery_amount', 'delivery_profit', 'delivery_margin']) {
      expect(brandUrl).toContain(col);
    }
    const regionUrl = String(findCall('report_region_breakdown_gen')![0]);
    for (const col of ['sale_target', 'sale_actual', 'sale_rate', 'delivery_target', 'delivery_actual', 'delivery_rate', 'daily_sale', 'daily_delivery', 'remaining_daily_sale_target', 'remaining_daily_delivery_target']) {
      expect(regionUrl).toContain(col);
    }
    // 头部 target 信息从 KPI 视图行派生（视图含 name/status/start_date/end_date，total 级 RLS 放行）
    expect(kpiUrl).toContain('name');
    expect(kpiUrl).toContain('status');
    expect(kpiUrl).toContain('start_date');
    expect(kpiUrl).toContain('end_date');
    // freshness 仍经 RPC 取（SECURITY DEFINER，代签 JWT 可执行）
    const freshnessCall = findCall('/rpc/get_data_freshness');
    expect(freshnessCall).toBeTruthy();
  });

  it('fixed 模式：URL 带 target_id=eq；头部从 KPI 行取 target 信息', async () => {
    const d = await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'fixed', targetId: 42 });
    const kpiCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('report_achievement_gen'));
    expect(String(kpiCall![0])).toContain('target_id=eq.42');
    expect(d?.target.name).toBe('6月经营目标');
  });

  it('KPI 查询失败 → null（整图不渲染）', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: string | URL | Request) =>
      String(input).includes('report_achievement_gen')
        ? ({ ok: false, json: async () => [] } as Response)
        : jsonResp(brandRows));
    expect(await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' })).toBeNull();
  });

  it('战区空 → 板块空数组（不整图失败）', async () => {
    mockViews({ region: [] });
    const data = await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' });
    expect(data).not.toBeNull();
    expect(data!.regions).toHaveLength(0);
  });

  it('cost 不可见（delivery_profit/delivery_margin NULL）→ 「—」灰（can_cost_visible false 语义）', async () => {
    mockViews({
      brand: brandRows.map((r) => ({ ...r, delivery_profit: null, delivery_margin: null })),
    });
    const data = await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' });
    expect(data).not.toBeNull();
    for (const b of data!.brands) {
      expect(b.deliveryProfit).toBe('—');
      expect(b.deliveryMargin).toBe('—');
      expect(b.marginColor).toBe('gray');
    }
  });

  it('freshness RPC 失败 → 头部时间降级空（标题仍取 KPI 行 name），不整图失败', async () => {
    mockViews({ freshness: null });
    const data = await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' });
    expect(data).not.toBeNull();
    // 标题来自 KPI 视图行（total 级 RLS 放行，稳定可得）；时间降级空
    expect(data!.target.name).toBe('6月经营目标');
    expect(data!.target.dataUpdatedAt).toBeNull();
    expect(data!.target.lastQueryAt).toBeNull();
  });

  it('KPI 行无 target_id → 不发 brand/region/targets 死查询，面板空数组 + 头部仍取 name', async () => {
    mockViews({ noTargetId: true });
    const data = await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' });
    expect(data).not.toBeNull();
    expect(data!.kpis).toHaveLength(6); // 4 金额 + 2 比率卡主板块仍完整（比率卡是派生值，不依赖 target_id）
    expect(data!.brands).toHaveLength(0);
    expect(data!.regions).toHaveLength(0);
    expect(data!.target.name).toBe('6月经营目标');
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('report_brand_metric_gen'))).toBe(false);
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('target_id=eq.0'))).toBe(false);
  });
});

describe('buildReportBannerUrl', () => {
  it('PNG → S3 put → 签名短 URL（值不落 URL）', async () => {
    const putMock = vi.fn(async () => {});
    const storage = { put: putMock, get: vi.fn(), list: vi.fn(), del: vi.fn() };
    const data = (await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' }))!;
    const url = await buildReportBannerUrl(data, storage);
    expect(url).not.toBeNull();
    expect(putMock).toHaveBeenCalledTimes(1);
    const [key, body] = putMock.mock.calls[0] as unknown as [string, Buffer];
    expect(String(key)).toMatch(/^push-assets\/banner\/[0-9a-f-]{36}\.png$/);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(url).toMatch(/^https:\/\/data\.shanhaiyiguo\.com\/api\/push\/banner\?k=[0-9a-f-]{36}&e=\d+&sig=/);
    // URL 不含任何值
    expect(url).not.toContain('416万');
    expect(url).not.toContain('熊喵');
  });

  it('S3 put 抛错 → null', async () => {
    const storage = { put: vi.fn(async () => { throw new Error('s3 down'); }), get: vi.fn(), list: vi.fn(), del: vi.fn() };
    const data = (await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' }))!;
    expect(await buildReportBannerUrl(data, storage)).toBeNull();
  });
});
