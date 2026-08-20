base = "/opt/data-analytics-platform/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-cecba9e1975382ec/node_modules/@wecom/wecom-openclaw-plugin/dist/src"
EMOJI_RE = '\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}'

# ========== Patch A: message-sender.js — 回复文本剥离 emoji ==========
p = base + "/message-sender.js"
s = open(p, encoding="utf-8").read()

# 加 stripEmoji 工具函数（模块内）
anchor = 'import { generateReqId } from "@wecom/aibot-node-sdk";'
assert anchor in s
s = s.replace(anchor, anchor + '\n\n// ★本地补丁 emoji-2026-08-20：剥离 emoji 图标（AI 味重，企微数据回答场景纯装饰）\nconst EMOJI_RE = /[' + EMOJI_RE + ']/gu;\nexport function stripEmoji(text) {\n  return typeof text === "string" ? text.replace(EMOJI_RE, "").replace(/\\s{2,}/g, " ") : text;\n}', 1)

# sendWeComReply: text 剥离
old = '''export async function sendWeComReply(params) {
    const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;
    if (!text) {
        return "";
    }'''
new = '''export async function sendWeComReply(params) {
    const { wsClient, frame, text: rawText, runtime, finish = true, streamId: existingStreamId } = params;
    const text = stripEmoji(rawText);
    if (!text) {
        return "";
    }'''
assert old in s, "sendWeComReply anchor missing"
s = s.replace(old, new, 1)

# sendWeComReplyNonBlocking: text 剥离
old2 = '''export async function sendWeComReplyNonBlocking(params) {
    const { wsClient, frame, text, runtime, streamId, finish = false } = params;
    if (!text) {
        return 'skipped';
    }'''
new2 = '''export async function sendWeComReplyNonBlocking(params) {
    const { wsClient, frame, text: rawText, runtime, streamId, finish = false } = params;
    const text = stripEmoji(rawText);
    if (!text) {
        return 'skipped';
    }'''
assert old2 in s, "sendWeComReplyNonBlocking anchor missing"
s = s.replace(old2, new2, 1)
open(p, "w", encoding="utf-8").write(s)
print("patchA ok")

# ========== Patch B: template-card-manager.js — 卡片字段剥离 emoji ==========
p2 = base + "/template-card-manager.js"
s2 = open(p2, encoding="utf-8").read()

# 引入 stripEmoji
anchor2 = 'import { extractTemplateCards } from "./template-card-parser.js";'
assert anchor2 in s2
s2 = s2.replace(anchor2, anchor2 + '\nimport { stripEmoji } from "./message-sender.js";', 1)

# sendTemplateCards 内：发送前对 cardJson 字符串字段做 emoji 剥离（嵌入选的原始卡 + 后续卡）
old3 = '''    const embedCard = cards[0];
    if (embedCard && typeof embedCard.cardJson?.card_type === "string" && wsClient.replyStreamWithCard) {'''
new3 = '''    // ★本地补丁 emoji-2026-08-20：对所有卡片字符串字段剥离 emoji（AI 味重）
    for (const card of cards) {
        if (card && card.cardJson) {
            card.cardJson = stripCardEmoji(card.cardJson);
        }
    }
    const embedCard = cards[0];
    if (embedCard && typeof embedCard.cardJson?.card_type === "string" && wsClient.replyStreamWithCard) {'''
assert old3 in s2, "embed anchor missing"
s2 = s2.replace(old3, new3, 1)

# 加 stripCardEmoji 辅助函数（在文件内）
anchor3 = 'function cloneTemplateCard(card) {'
assert anchor3 in s2
helper = '''// ★本地补丁 emoji-2026-08-20：递归剥离卡片 JSON 中所有字符串字段的 emoji
const CARD_EMOJI_RE = /[' + EMOJI_RE + ']/gu;
function stripCardEmoji(obj) {
  if (typeof obj === "string") return obj.replace(CARD_EMOJI_RE, "").replace(/\\s{2,}/g, " ");
  if (Array.isArray(obj)) return obj.map(stripCardEmoji);
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) obj[k] = stripCardEmoji(obj[k]);
  }
  return obj;
}
function cloneTemplateCard(card) {'''
s2 = s2.replace(anchor3, helper, 1)
open(p2, "w", encoding="utf-8").write(s2)
print("patchB ok")
