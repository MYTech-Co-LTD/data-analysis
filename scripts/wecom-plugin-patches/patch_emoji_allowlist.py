# ★补丁 refine-2026-08-20：撤销 markdown 剥离；emoji 改为"剥离除洋气白名单外全部"
base = "/opt/data-analytics-platform/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-cecba9e1975382ec/node_modules/@wecom/wecom-openclaw-plugin/dist/src"
p = base + "/message-sender.js"
s = open(p, encoding="utf-8").read()

# 定位旧的 sanitizer 块（emoji+md 版），整体替换为洋气白名单版（不剥 markdown）
start_marker = "// ★本地补丁 emoji+md-2026-08-20"
end_marker = "export function stripEmojiAndMarkdown"
si = s.find(start_marker)
ei = s.find(end_marker)
assert si != -1 and ei != -1 and ei > si, "sanitizer block not found"
# 函数体结束：找到该函数的右大括号行（以 "}" 开头的行，且后面是空行或 export 结束）
body_end = s.find("\n}\n", ei)
assert body_end != -1
# 含函数完整定义到 body_end+2（含右括号）
seg_start = si
seg_end = body_end + 3

new_block = '''// ★本地补丁 emoji-allow-2026-08-20：剥离除"洋气白名单"外的 emoji（AI 味图标剔除，保留 ✨🔥💯📈 等克制的装饰）；不碰 markdown 语法
const EMOJI_RE = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
const EMOJI_ALLOWED = new Set(["✨", "🔥", "💯", "📈", "💡", "🎯", "⚡", "💎", "🎉", "⭐"]);
export function stripEmojiAndMarkdown(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(EMOJI_RE, (m) => (EMOJI_ALLOWED.has(m) ? m : ""));
  return out.replace(/\\n{3,}/g, "\\n\\n").replace(/[ \\t]{2,}/g, " ").trim();
}'''
s = s[:seg_start] + new_block + s[seg_end:]
open(p, "w", encoding="utf-8").write(s)
print("message-sender sanitizer refined (markdown kept, emoji allowlist)")

# 卡片字段沿用同一函数（allowlist 同样生效）
print("card fields use same stripEmojiAndMarkdown -> allowlist applies")
