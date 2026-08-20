// web/lib/push/preset-validate.ts
// preset card_json 服务端校验（限制表：docs/ops/wecom-message-capabilities.md）
// Review 加固：card_type 收敛 news_notice（全局统一裁定）+ aspect_ratio/title 严格类型（拒 NaN/非字符串）

export function validateCardJson(card: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['card_json 必须是对象'] };
  }
  const c = card as Record<string, unknown>;
  const bytes = (s: unknown) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);

  // 全局约束：消息类型统一 template_card news_notice（docs/ops/wecom-message-capabilities.md 统一裁定 2026-08-20）
  // 终审 I5：card_type 整个缺失也必须拒——企微卡片必需 card_type，缺字段发卡必败。
  //   旧写法只在字段存在时拒非 news_notice，字段缺失则通过 → 全局约束被绕过。
  if ((c as { card_type?: unknown }).card_type !== 'news_notice') {
    errors.push('card_type 必须为 news_notice');
  }

  const mt = c.main_title as Record<string, unknown> | undefined;
  const title = mt?.title;
  if (typeof title !== 'string' || title.length === 0) errors.push('main_title.title 必填');
  else if (bytes(title) > 128) errors.push('main_title.title >128 字节');

  const desc = mt?.desc;
  if (desc !== undefined && typeof desc !== 'string') errors.push('main_title.desc 必须是字符串');
  else if (desc && bytes(desc) > 512) errors.push('main_title.desc >512 字节');

  const ci = c.card_image as Record<string, unknown> | undefined;
  if (!ci?.url) errors.push('card_image.url 必填');
  else {
    const ar = ci.aspect_ratio;
    if (ar !== undefined) {
      // 必须是有穷数字且落在 1.3~2.25（Number('abc')→NaN 不再静默通过）
      if (typeof ar !== 'number' || !Number.isFinite(ar) || ar < 1.3 || ar > 2.25) {
        errors.push('card_image.aspect_ratio 须是 1.3~2.25 的数字');
      }
    }
  }

  const ca = c.card_action as Record<string, unknown> | undefined;
  if (!ca?.url) errors.push('card_action.url 必填');
  else if (bytes(ca.url) > 1024) errors.push('card_action.url >1024 字节');

  const vcl = c.vertical_content_list;
  if (Array.isArray(vcl) && vcl.length > 4) errors.push('vertical_content_list 最多 4 行');
  const hcl = c.horizontal_content_list;
  if (Array.isArray(hcl) && hcl.length > 6) errors.push('horizontal_content_list 最多 6 行');

  return { ok: errors.length === 0, errors };
}
