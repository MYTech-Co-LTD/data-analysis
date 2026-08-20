// web/lib/push/preset-validate.ts
// preset card_json 服务端校验（限制表：docs/ops/wecom-message-capabilities.md）

export function validateCardJson(card: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['card_json 必须是对象'] };
  }
  const c = card as Record<string, unknown>;
  const bytes = (s: unknown) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);

  const title = (c.main_title as Record<string, unknown> | undefined)?.title;
  if (!c.main_title || !title) errors.push('main_title.title 必填');
  else if (bytes(title) > 128) errors.push('main_title.title >128 字节');

  const desc = (c.main_title as Record<string, unknown> | undefined)?.desc;
  if (desc && bytes(desc) > 512) errors.push('main_title.desc >512 字节');

  if (!c.card_image || !(c.card_image as Record<string, unknown>)?.url) errors.push('card_image.url 必填');
  else {
    const ar = Number((c.card_image as Record<string, unknown>).aspect_ratio);
    if (ar && (ar < 1.3 || ar > 2.25)) errors.push('card_image.aspect_ratio 须在 1.3~2.25');
  }

  if (!c.card_action || !(c.card_action as Record<string, unknown>)?.url) errors.push('card_action.url 必填');
  else if (bytes((c.card_action as Record<string, unknown>).url) > 1024) errors.push('card_action.url >1024 字节');

  const vcl = c.vertical_content_list;
  if (Array.isArray(vcl) && vcl.length > 4) errors.push('vertical_content_list 最多 4 行');
  const hcl = c.horizontal_content_list;
  if (Array.isArray(hcl) && hcl.length > 6) errors.push('horizontal_content_list 最多 6 行');

  return { ok: errors.length === 0, errors };
}
