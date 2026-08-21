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

// mock 全局 fetch（PostgREST 3 视图 + 不真发 S3）
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

// 视图行数据
const kpiRows = [
  { metric_code: 'sale_amount', target_value: 100, actual_value: 4160000, achievement_rate: 0.606 },
  { metric_code: 'delivery_amount', target_value: 100, actual_value: 1200000, achievement_rate: 0.88 },
  { metric_code: 'outbound_amt', target_value: 100, actual_value: 2100000, achievement_rate: 1.012 },
  { metric_code: 'outbound_profit', target_value: 100, actual_value: 320000, achievement_rate: 0.45 },
];
const brandRows = [
  { system_book_code: '3120', brand_name: '熊喵鲜生', sale_amount: 3100000, sale_rate: 0.62 },
  { system_book_code: '64188', brand_name: '品品甜', sale_amount: 1060000, sale_rate: 0.55 },
  { system_book_code: '合计', brand_name: '合计', sale_amount: 4160000, sale_rate: 0.606 },
];
const regionRows = [
  { region_name: '东', sale_actual: 1400000, sale_rate: 0.72 },
  { region_name: '南', sale_actual: 1100000, sale_rate: 0.65 },
  { region_name: '西', sale_actual: 980000, sale_rate: 0.58 },
  { region_name: '中', sale_actual: 680000, sale_rate: 0.5 },
];

function mockViews(rows: { kpi?: typeof kpiRows; brand?: typeof brandRows; region?: typeof regionRows }) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const u = String(input);
    if (u.includes('/report_achievement_gen')) return jsonResp(rows.kpi ?? kpiRows);
    if (u.includes('/report_brand_metric_gen')) return jsonResp(rows.brand ?? brandRows);
    if (u.includes('/report_region_breakdown_gen')) return jsonResp(rows.region ?? regionRows);
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

  it('follow 模式：查 3 视图 → KPI 4 卡/品牌 3 行/战区 4 行，格式化正确', async () => {
    const data = await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'follow' });
    expect(data).not.toBeNull();
    expect(data!.kpis).toHaveLength(4);
    expect(data!.kpis[0].label).toBe('销售额');
    expect(data!.kpis[0].value).toBe('¥4,160,000');
    expect(data!.kpis[0].rate).toBe('60.6%');
    expect(data!.kpis[0].rateColor).toBe('amber');
    expect(data!.kpis[2].rateColor).toBe('green');   // 101.2%
    expect(data!.kpis[3].rateColor).toBe('red');     // 45%
    expect(data!.brands.map((b) => b.sbc)).toEqual(['3120', '64188', '合计']);
    expect(data!.brands[0].name).toBe('熊喵鲜生');
    expect(data!.regions.map((r) => r.name)).toEqual(['东', '南', '西', '中']);
  });

  it('follow 查询 URL 含 status=active + 日期窗 + limit 单行（PR #64）', async () => {
    await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'follow' });
    const kpiCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('report_achievement_gen'));
    const url = String(kpiCall![0]);
    expect(url).toContain('status=eq.active');
    expect(url).toContain('start_date=lte.');
    expect(url).toContain('end_date=gte.');
    expect(url).toContain('limit=1');
  });

  it('fixed 模式：URL 带 target_id=eq', async () => {
    await resolveReportBannerData({ jwt: 'jwt-1', targetMode: 'fixed', targetId: 42 });
    const brandCall = fetchMock.mock.calls.find((c: unknown[]) => String(c[0]).includes('report_brand_metric_gen'));
    expect(String(brandCall![0])).toContain('target_id=eq.42');
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
    expect(url).not.toContain('4,160');
    expect(url).not.toContain('熊喵');
  });

  it('S3 put 抛错 → null', async () => {
    const storage = { put: vi.fn(async () => { throw new Error('s3 down'); }), get: vi.fn(), list: vi.fn(), del: vi.fn() };
    const data = (await resolveReportBannerData({ jwt: 'j', targetMode: 'follow' }))!;
    expect(await buildReportBannerUrl(data, storage)).toBeNull();
  });
});
