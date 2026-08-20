/**
 * renderPresetContent 测试（2026-08-20）
 * 覆盖：card_json 完整 template_card（news_notice 统一裁定）深度插值 / 简写兼容 / textcard 兼容 / 变量缺失占位
 */
import { describe, it, expect } from 'vitest';
import { renderPresetContent, type MessagePreset } from '../message-preset';

const basePreset = (over: Partial<MessagePreset>): MessagePreset => ({
  preset_id: 'p1',
  workflow_id: 'scheduled-report',
  msgtype: 'textcard',
  enabled: true,
  ...over,
} as MessagePreset);

describe('renderPresetContent', () => {
  it('card_json（news_notice）：深度插值 + 嵌套 template_card 键透传', () => {
    const preset = basePreset({
      msgtype: 'template_card',
      card_json: {
        card_type: 'news_notice',
        source: { desc: '山海数据平台', desc_color: 1 },
        main_title: { title: '📊 数据日报', desc: '销售 {{sale_amount}} · 达成率 {{achievement_rate}}' },
        card_image: { url: 'https://data.shanhaiyiguo.com/push/banner.png', aspect_ratio: 2.25 },
        vertical_content_list: [
          { title: '销售额', value: '{{sale_amount}}' },
          { title: '达成率', value: '{{achievement_rate}}' },
        ],
        card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
      },
    });
    const out = JSON.parse(
      renderPresetContent(preset, { sale_amount: '¥4,168,618', achievement_rate: '60.7%' })
    );
    expect(out.msgtype).toBe('template_card');
    // 完整 card 嵌套在 template_card 键（bridge route 对该键原样透传）
    expect(out.template_card.card_type).toBe('news_notice');
    expect(out.template_card.main_title.desc).toBe('销售 ¥4,168,618 · 达成率 60.7%');
    expect(out.template_card.vertical_content_list[0].value).toBe('¥4,168,618');
    expect(out.template_card.vertical_content_list[1].value).toBe('60.7%');
    expect(out.template_card.card_action.url).toBe('https://data.shanhaiyiguo.com/reports/targets');
    // 非模板字段原样保留（数字不被字符串化破坏）
    expect(out.template_card.card_image.aspect_ratio).toBe(2.25);
    expect(out.template_card.source.desc_color).toBe(1);
  });

  it('变量缺失 → {{var}} 占位符保留（不产生 undefined 字面量）', () => {
    const preset = basePreset({
      msgtype: 'template_card',
      card_json: { card_type: 'news_notice', main_title: { desc: '销售 {{sale_amount}}' } },
    });
    const out = JSON.parse(renderPresetContent(preset, {}));
    expect(out.template_card.main_title.desc).toBe('销售 {{sale_amount}}');
  });

  it('template_card 简写（无 card_json）保持向后兼容', () => {
    const preset = basePreset({ msgtype: 'template_card', title: 'T', description: 'D {{sale_amount}}' });
    const out = JSON.parse(renderPresetContent(preset, { sale_amount: '¥1' }));
    expect(out.main_title).toBe('T');
    expect(out.sub_title_text).toBe('D ¥1');
  });

  it('textcard 兼容（url_var 取变量）', () => {
    const preset = basePreset({ title: 't', description: 'd', url_var: 'detail_url', btntxt: '详情' });
    const out = JSON.parse(renderPresetContent(preset, { detail_url: 'https://x' }));
    expect(out.msgtype).toBe('textcard');
    expect(out.url).toBe('https://x');
    expect(out.btntxt).toBe('详情');
  });
});
