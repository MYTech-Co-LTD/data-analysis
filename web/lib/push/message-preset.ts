// web/lib/push/message-preset.ts
// 推送消息呈现配置渲染（平台能力，2026-08-20）：
//   push_message_presets 定义 workflow 的消息类型（text/markdown/textcard/news/template_card）+ 字段；
//   本模块把 preset + 已渲染变量（detail_url 等）渲染成 message_content（JSON 契约给 bridge dispatch）。
//   引擎把 message_content 放进 payload，Novu content 固定 {{payload.message_content}}。

export interface MessagePreset {
  preset_id: string;
  workflow_id: string;
  msgtype: 'text' | 'markdown' | 'textcard' | 'news' | 'template_card';
  title?: string | null;
  description?: string | null;
  url_var?: string | null;
  btntxt?: string | null;
  articles_json?: unknown;
  content_template?: string | null;
  enabled: boolean;
}

/** 简单 {{var}} 插值（对 content_template；只替换字符串值） */
function interpolate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return typeof v === 'string' ? v : `{{${key}}}`;
  });
}

/** 取 URL（url_var 指向的变量值；空则无跳转） */
function pickUrl(preset: MessagePreset, vars: Record<string, unknown>): string {
  if (!preset.url_var) return '';
  const v = vars[preset.url_var];
  return typeof v === 'string' ? v : '';
}

/**
 * 渲染 preset → message_content
 * - text/markdown：content_template 插值（纯文本）
 * - textcard/news/template_card：JSON 契约（含 msgtype，bridge 按此 dispatch）
 */
export function renderPresetContent(preset: MessagePreset, vars: Record<string, unknown>): string {
  const url = pickUrl(preset, vars);
  switch (preset.msgtype) {
    case 'text':
    case 'markdown':
      return interpolate(preset.content_template ?? preset.title ?? '', vars);

    case 'textcard':
      return JSON.stringify({
        msgtype: 'textcard',
        title: interpolate(preset.title ?? '', vars),
        description: interpolate(preset.description ?? '', vars),
        url,
        ...(preset.btntxt ? { btntxt: preset.btntxt } : {}),
      });

    case 'news': {
      // articles_json 为模板数组（可含 {{var}}）；无则用 title/description/url 单条
      const arts = Array.isArray(preset.articles_json)
        ? (preset.articles_json as Array<Record<string, unknown>>)
        : [{ title: preset.title ?? '', description: preset.description ?? '', url }];
      return JSON.stringify({
        msgtype: 'news',
        articles: arts.map((a) => ({
          title: String(interpolate(String(a.title ?? ''), vars)),
          description: a.description ? String(interpolate(String(a.description), vars)) : undefined,
          url: String(interpolate(String(a.url ?? url), vars)),
          ...(a.picurl ? { picurl: String(a.picurl) } : {}),
        })),
      });
    }

    case 'template_card':
      return JSON.stringify({
        msgtype: 'template_card',
        main_title: interpolate(preset.title ?? '', vars),
        sub_title_text: preset.description ? interpolate(preset.description, vars) : undefined,
        ...(url ? { url } : {}),
      });

    default:
      return JSON.stringify({ msgtype: 'text', content: interpolate(preset.title ?? '', vars) });
  }
}
