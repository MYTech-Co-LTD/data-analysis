// web/lib/push/message-preset.ts
// 推送消息呈现配置渲染（平台能力，2026-08-20）：
//   push_message_presets 定义 workflow 的消息类型（text/markdown/textcard/news/template_card）+ 字段；
//   本模块把 preset + 已渲染变量（detail_url 等）渲染成 message_content（JSON 契约给 bridge dispatch）。
//   引擎把 message_content 放进 payload，Novu content 固定 {{{message_content}}}。
//   ⚠️ 两条 Novu 模板语法铁律（2026-08-20 生产两连踩，详见 push-system-prod memory）：
//   1. 无 payload. 前缀：渲染上下文是 payload 平铺（worker getCompilePayload），{{payload.X}} 恒渲染空串
//      → bridge 400 missing content。
//   2. 必须 triple-stash {{{X}}}：CompileTemplateUsecase 用原生 Handlebars，双花括号 {{X}} 会 HTML
//      转义（" → &quot;）→ JSON.parse 失败 → bridge markdown 兜底 → 用户收到 JSON 裸文本而非卡片。
import { BANNER_PLACEHOLDER_URL } from './banner';

export interface MessagePreset {
  preset_id: string;
  workflow_id: string;
  msgtype: 'text' | 'markdown' | 'textcard' | 'news' | 'template_card';
  title?: string | null;
  description?: string | null;
  url_var?: string | null;
  btntxt?: string | null;
  articles_json?: unknown;
  /** template_card：完整 card 对象模板（news_notice 等 card_type；{{var}} 深度插值） */
  card_json?: unknown;
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

/** {{var}} 深度插值（对象/数组递归；card_json 等 JSONB 模板用） */
function deepInterpolate(node: unknown, vars: Record<string, unknown>): unknown {
  if (typeof node === 'string') return interpolate(node, vars);
  if (Array.isArray(node)) return node.map((n) => deepInterpolate(n, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = deepInterpolate(v, vars);
    }
    return out;
  }
  return node;
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

    case 'template_card': {
      // card_json：完整 card 模板（news_notice 等 card_type）——嵌套进 template_card 键透传，
      //   bridge route 对该键原样下发（支持 card_image/card_action/vertical_content_list 全字段）
      const card = preset.card_json;
      if (card && typeof card === 'object' && !Array.isArray(card)) {
        const interpolated = deepInterpolate(card, vars) as { card_image?: { url?: unknown } };
        // 横幅占位图 → 签名横幅 URL（架构 §7.4 方案 C；vars.banner_url 由引擎 injectBanner 注入。
        //   槽位缺失时引擎不注入 banner_url → 保留静态占位图优雅降级，不产生字面 {{banner_url}}）
        if (
          interpolated.card_image?.url === BANNER_PLACEHOLDER_URL &&
          typeof vars.banner_url === 'string'
        ) {
          interpolated.card_image.url = vars.banner_url;
        }
        return JSON.stringify({
          msgtype: 'template_card',
          template_card: interpolated,
        });
      }
      // 简写：main_title + sub_title_text + url（text_notice 便捷）
      return JSON.stringify({
        msgtype: 'template_card',
        main_title: interpolate(preset.title ?? '', vars),
        sub_title_text: preset.description ? interpolate(preset.description, vars) : undefined,
        ...(url ? { url } : {}),
      });
    }

    default:
      return JSON.stringify({ msgtype: 'text', content: interpolate(preset.title ?? '', vars) });
  }
}
