// web/lib/push/__tests__/preset-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateCardJson } from '../preset-validate';

describe('validateCardJson', () => {
  it('合法 news_notice 通过', () => {
    const card = {
      card_type: 'news_notice',
      main_title: { title: '📊 数据日报', desc: '销售 ¥1' },
      card_image: { url: 'https://x/banner.png', aspect_ratio: 2.25 },
      card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
    };
    expect(validateCardJson(card)).toEqual({ ok: true, errors: [] });
  });
  it('缺必填（main_title/card_image/card_action）报错', () => {
    const r = validateCardJson({ card_type: 'news_notice' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('main_title');
    expect(r.errors.join()).toContain('card_image');
    expect(r.errors.join()).toContain('card_action');
  });
  it('超限：标题>128B / url>1024B / vertical>4 行 / aspect_ratio 越界', () => {
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 'x'.repeat(129) },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x/' + 'a'.repeat(1025) },
    }).ok).toBe(false);
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 2.5 }, // >2.25
      card_action: { type: 1, url: 'https://x' },
    }).ok).toBe(false);
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x' },
      vertical_content_list: Array.from({ length: 5 }, (_, i) => ({ title: 'k', value: String(i) })),
    }).ok).toBe(false);
  });
  it('card_type 非 news_notice 报错（全局统一裁定）', () => {
    const r = validateCardJson({
      card_type: 'text_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('news_notice');
  });
  it('边界容错：aspect_ratio=NaN/字符串拒、非字符串 title 拒', () => {
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 'abc' as unknown as number }, // NaN 静默通过回归
      card_action: { type: 1, url: 'https://x' },
    }).ok).toBe(false);
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 123 as unknown as string },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x' },
    }).ok).toBe(false);
    // 缺省 aspect_ratio 仍合法（默认 1.3）
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u' },
      card_action: { type: 1, url: 'https://x' },
    }).ok).toBe(true);
  });
});
