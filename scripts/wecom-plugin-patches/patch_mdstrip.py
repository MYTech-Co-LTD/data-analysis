base = "/opt/data-analytics-platform/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-cecba9e1975382ec/node_modules/@wecom/wecom-openclaw-plugin/dist/src"
p = base + "/message-sender.js"
s = open(p, encoding="utf-8").read()

# 扩展 stripEmoji → stripEmojiAndMarkdown（剥离 emoji + markdown 语法：** ## - 列表 | 表格 反引号 分隔线）
old = '''// ★本地补丁 emoji-2026-08-20：剥离 emoji 图标（AI 味重，企微数据回答场景纯装饰）
const EMOJI_RE = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
export function stripEmoji(text) {
  return typeof text === "string" ? text.replace(EMOJI_RE, "").replace(/\\s{2,}/g, " ") : text;
}'''
new = '''// ★本地补丁 emoji+md-2026-08-20：剥离 emoji 图标与 markdown 语法（AI 味重 + 企微纯文本原样显示星号/井号/管道符）
const EMOJI_RE = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
const MD_RE = [
  /\\*\\*/g,                     // 加粗 **
  /#{1,6}(?=\\s)/g,              // 标题 ##/###（仅当后随空白；保护 #泰国金枕 这类真名）
  /^\\s*[-*]\\s+/gm,             // 无序列表 - / *
  /`/g,                          // 反斜引号
  /^\\s*[-=_]{3,}\\s*$/gm,       // 分隔线 --- === ___
  /^\\s*\\|.*\\|\\s*$/gm,          // 表格行（整行）
  /\\|/g,                         // 残留管道符
];
export function stripEmojiAndMarkdown(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(EMOJI_RE, "");
  for (const re of MD_RE) out = out.replace(re, "");
  return out.replace(/\\n{3,}/g, "\\n\\n").replace(/[ \\t]{2,}/g, " ").trim();
}'''
assert old in s, "stripEmoji fn not found"
s = s.replace(old, new, 1)

# 调用点替换
s = s.replace("const text = stripEmoji(rawText);", "const text = stripEmojiAndMarkdown(rawText);")
open(p, "w", encoding="utf-8").write(s)
print("message-sender patched")

# template-card-manager 引用更新（卡片字段复用同一函数，剥 emoji + md 语法）
p2 = base + "/template-card-manager.js"
s2 = open(p2, encoding="utf-8").read()
old2 = 'import { stripEmoji } from "./message-sender.js";'
new2 = 'import { stripEmojiAndMarkdown as stripEmoji } from "./message-sender.js";'
assert old2 in s2, "card import not found"
s2 = s2.replace(old2, new2, 1)
open(p2, "w", encoding="utf-8").write(s2)
print("template-card-manager patched")
