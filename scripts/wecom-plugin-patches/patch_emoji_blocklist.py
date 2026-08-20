# ★补丁 emoji-blocklist-2026-08-20：只剔除 📊🔥📈，其余 emoji 全部保留（黑名单模式）；markdown 语法不剥离
# 幂等：按"补丁注释行 → 函数体"定位 sanitizer 块整体替换，兼容 allowlist/mdstrip 各历史状态。
import re

base = "/opt/data-analytics-platform/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-cecba9e1975382ec/node_modules/@wecom/wecom-openclaw-plugin/dist/src"
p = base + "/message-sender.js"
s = open(p, encoding="utf-8").read()

fn = "export function stripEmojiAndMarkdown(text) {"
fi = s.find(fn)
assert fi != -1, "sanitizer function not found"
# 函数体结束（右大括号行）
be = s.find("\n}\n", fi)
assert be != -1
# 函数前的补丁注释行起点（往前找最近的 "// ★本地补丁"）
ci = s.rfind("// ★本地补丁", 0, fi)
if ci == -1:
    ci = s.rfind("//", 0, fi)  # 兜底：任意注释行
assert ci != -1

new_block = '''// ★本地补丁 emoji-blocklist-2026-08-20：只剔除 📊🔥📈，其余 emoji 全部保留；不剥离 markdown 语法
const EMOJI_RE = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
const EMOJI_BLOCKED = new Set(["📊", "🔥", "📈"]);
export function stripEmojiAndMarkdown(text) {
  if (typeof text !== "string") return text;
  let out = text.replace(EMOJI_RE, (m) => (EMOJI_BLOCKED.has(m) ? "" : m));
  return out.replace(/\\n{3,}/g, "\\n\\n").replace(/[ \\t]{2,}/g, " ").trim();
}'''
s = s[:ci] + new_block + s[be + 3:]
open(p, "w", encoding="utf-8").write(s)
print("message-sender sanitizer -> blocklist (only 📊🔥📈 stripped)")
