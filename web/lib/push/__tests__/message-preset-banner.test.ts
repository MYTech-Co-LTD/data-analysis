/**
 * 横幅占位替换（Task 2，2026-08-20）：card_image.url 占位 + vars.banner_url → 替换为签名 URL；
 * 无 banner_url → 保留占位（M7 fail-closed 优雅降级）；非占位 url → 不破坏；非 template_card → 不涉及。
 */
import { describe, it, expect } from 'vitest';
import { renderPresetContent, type MessagePreset } from '../message-preset';
import { BANNER_PLACEHOLDER_URL } from '../banner';

const preset: MessagePreset = {
  preset_id: 'scheduled-report-card',
  workflow_id: 'scheduled-report',
  msgtype: 'template_card',
  enabled: true,
  card_json: {
    card_type: 'news_notice',
    main_title: { title: '📊 数据日报', desc: '销售 {{sale_amount}} · 达成率 {{achievement_rate}}' },
    card_image: { url: BANNER_PLACEHOLDER_URL, aspect_ratio: 2.25 },
    vertical_content_list: [
      { title: '销售额', value: '{{sale_amount}}' },
      { title: '达成率', value: '{{achievement_rate}}' },
    ],
  },
};

describe('renderPresetContent 横幅占位替换', () => {
  it('vars.banner_url 存在 → card_image.url 换成签名 URL，其余字段不变', () => {
    const mc = renderPresetContent(preset, {
      sale_amount: '¥128,500', achievement_rate: '86.4%',
      banner_url: 'https://data.shanhaiyiguo.com/api/push/banner?d=2026-08-20&t=123&sig=abc',
    });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe('https://data.shanhaiyiguo.com/api/push/banner?d=2026-08-20&t=123&sig=abc');
    expect(json.template_card.vertical_content_list[0].value).toBe('¥128,500');
    expect(json.template_card.card_type).toBe('news_notice');
  });
  it('无 banner_url → 保留占位图（优雅降级）', () => {
    const mc = renderPresetContent(preset, { sale_amount: '¥128,500', achievement_rate: '86.4%' });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe(BANNER_PLACEHOLDER_URL);
  });
  it('card_image.url 非占位（如 {{banner_url}} 模板 token 或自定义）→ 不破坏', () => {
    const p2: MessagePreset = {
      ...preset,
      card_json: { ...(preset.card_json as Record<string, unknown>), card_image: { url: '{{banner_url}}', aspect_ratio: 2.25 } },
    };
    const mc = renderPresetContent(p2, { sale_amount: '¥1', achievement_rate: '50%', banner_url: 'https://x/y' });
    const json = JSON.parse(mc);
    expect(json.template_card.card_image.url).toBe('https://x/y'); // deepInterpolate 自然解析 token
  });
});

// 报表数据横幅（Task 5，2026-08-21）：card_image.url = {{report_banner}}（未解析字面量）
//   → 回退 BANNER_PLACEHOLDER_URL（降级不拒投，Global Constraint 7；M7 fail-closed 会拒投整条消息）
const reportBannerPreset: MessagePreset = {
  preset_id: 'scheduled-report-card',
  workflow_id: 'scheduled-report',
  msgtype: 'template_card',
  enabled: true,
  card_json: {
    card_type: 'news_notice',
    card_image: { url: '{{report_banner}}', aspect_ratio: 2.25 },
  },
};

describe('report_banner 未解析回退', () => {
  it('vars 无 report_banner → card_image.url 回退静态占位图（不残留 {{report_banner}} 字面量）', () => {
    const out = JSON.parse(renderPresetContent(reportBannerPreset, { sale_amount: '¥1' }));
    expect(out.template_card.card_image.url).toBe(BANNER_PLACEHOLDER_URL);
    expect(JSON.stringify(out)).not.toContain('{{report_banner}}');
  });
  it('vars 有 report_banner → 用签名 URL（deepInterpolate 替换）', () => {
    const out = JSON.parse(renderPresetContent(reportBannerPreset, { report_banner: 'https://x/api/push/banner?k=1&sig=2' }));
    expect(out.template_card.card_image.url).toBe('https://x/api/push/banner?k=1&sig=2');
  });
});
