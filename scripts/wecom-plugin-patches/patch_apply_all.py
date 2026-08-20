#!/usr/bin/env python3
# scripts/wecom-plugin-patches/patch_apply_all.py
# ★确定性重建 wecom 插件本地补丁（openclaw 更新/插件收敛后需重跑）：
#   1) 从 pristine/ 恢复三个文件（npm 原始包 @wecom/wecom-openclaw-plugin@2026.5.7）
#   2) embed    —— 模板卡片嵌入流式回复（stream_with_template_card），文本+卡片一条消息
#   3) emoji    —— 只剔除 📊🔥📈（黑名单），其余 emoji 保留；不剥离 markdown 语法
# 用法：python3 patch_apply_all.py <plugin-src-dir>（或默认从环境变量/标准路径推断）
import os
import sys
import shutil

def find_plugin_src():
    if len(sys.argv) > 1:
        p = sys.argv[1]
        if os.path.isdir(p):
            return p
    home = os.environ.get("OPENCLAW_HOME", "/opt/data-analytics-platform/openclaw/state")
    cand = os.path.join(home, "npm/projects/wecom-wecom-openclaw-plugin-*/node_modules/@wecom/wecom-openclaw-plugin/dist/src")
    import glob
    hits = glob.glob(cand)
    if hits:
        return hits[0]
    raise SystemExit("❌ 未找到 wecom 插件 src 目录")

SRC = find_plugin_src()
PRIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pristine")

def read(p):
    return open(p, encoding="utf-8").read()

def write(p, s):
    open(p, "w", encoding="utf-8").write(s)

def expect(sub, s, what):
    assert sub in s, f"[{what}] anchor 缺失: {sub[:60]}"

# ── 1) pristine 恢复 ──
for f in ["message-sender.js", "template-card-manager.js", "monitor.js"]:
    shutil.copy(os.path.join(PRIST, f), os.path.join(SRC, f))
    print(f"restored {f}")

# ── 2) embed：template-card-manager.js ──
p = os.path.join(SRC, "template-card-manager.js")
s = read(p)
old = "    await sendTemplateCards({ ...params, cards });\n    return { remainingText, cardsDetected: true };"
new = "    await sendTemplateCards({ ...params, cards, remainingText });\n    return { remainingText, cardsDetected: true };"
expect(old, s, "embed-proc"); s = s.replace(old, new, 1)

old = """export async function sendTemplateCards(params) {
    const { wsClient, frame, state, runtime, account, cards } = params;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    for (const card of cards) {"""
new = """export async function sendTemplateCards(params) {
    const { wsClient, frame, state, runtime, account, cards, remainingText } = params;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    // ★embed 补丁（2026-08-20）：首卡与剩余文本作为一条 stream_with_template_card 消息发出
    const embedCard = cards[0];
    if (embedCard && typeof embedCard.cardJson?.card_type === "string" && wsClient.replyStreamWithCard) {
        try {
            await wsClient.replyStreamWithCard(frame, state.streamId || "stream_embed", remainingText || "", true, {
                templateCard: embedCard.cardJson,
            });
            state.hasTemplateCard = true;
            state.embeddedCardSent = true;
            saveTemplateCardToCache({ accountId: account.accountId, templateCard: embedCard.cardJson, runtime });
            runtime.log?.(`[wecom][template-card] Card EMBEDDED in stream reply: card_type=${embedCard.cardType}`);
            for (const card of cards.slice(1)) {
                if (typeof card.cardJson?.card_type !== "string") continue;
                await wsClient.sendMessage(chatId, { msgtype: "template_card", template_card: card.cardJson });
                saveTemplateCardToCache({ accountId: account.accountId, templateCard: card.cardJson, runtime });
            }
            return;
        } catch (err) {
            runtime.error?.(`[wecom][template-card] Embed failed, fallback separate: ${String(err).slice(0, 120)}`);
        }
    }
    for (const card of cards) {"""
expect(old, s, "embed-send"); s = s.replace(old, new, 1)
write(p, s)

# ── 3) emoji：message-sender.js（sanitizer 插入 + 两处调用点） ──
p = os.path.join(SRC, "message-sender.js")
s = read(p)
anchor = 'import { withTimeout } from "./timeout.js";'
expect(anchor, s, "emoji-import")
sanitizer = '''
// ★emoji 补丁（2026-08-20）：只剔除 📊🔥📈，其余 emoji 保留；不剥离 markdown 语法
const EMOJI_RE = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/gu;
const EMOJI_BLOCKED = new Set(["📊", "🔥", "📈"]);
export function stripEmojiAndMarkdown(text) {
  if (typeof text !== "string") return text;
  return text.replace(EMOJI_RE, (m) => (EMOJI_BLOCKED.has(m) ? "" : m));
}'''
s = s.replace(anchor, anchor + sanitizer, 1)

old = "    const { wsClient, frame, text, runtime, finish = true, streamId: existingStreamId } = params;"
new = "    const { wsClient, frame, text: rawText, runtime, finish = true, streamId: existingStreamId } = params;\n    const text = stripEmojiAndMarkdown(rawText);"
expect(old, s, "emoji-call1"); s = s.replace(old, new, 1)

old = "    const { wsClient, frame, text, runtime, streamId, finish = false } = params;"
new = "    const { wsClient, frame, text: rawText, runtime, streamId, finish = false } = params;\n    const text = stripEmojiAndMarkdown(rawText);"
expect(old, s, "emoji-call2"); s = s.replace(old, new, 1)
write(p, s)

# ── 3b) emoji：template-card-manager.js（import + 递归 helper + 发送前应用） ──
p = os.path.join(SRC, "template-card-manager.js")
s = read(p)
anchor = 'import { extractTemplateCards } from "./template-card-parser.js";'
expect(anchor, s, "emoji-tcm-import")
s = s.replace(anchor, anchor + '\nimport { stripEmojiAndMarkdown } from "./message-sender.js";', 1)

anchor = "function cloneTemplateCard(card) {"
expect(anchor, s, "emoji-tcm-helper")
helper = '''// ★emoji 补丁（2026-08-20）：卡片字符串字段复用 stripEmojiAndMarkdown（黑名单 📊🔥📈）
function stripCardEmoji(obj) {
  if (typeof obj === "string") return stripEmojiAndMarkdown(obj);
  if (Array.isArray(obj)) return obj.map(stripCardEmoji);
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) obj[k] = stripCardEmoji(obj[k]);
  }
  return obj;
}
function cloneTemplateCard(card) {'''
s = s.replace(anchor, helper, 1)

old = "    const embedCard = cards[0];\n    if (embedCard"
new = "    for (const card of cards) {\n        if (card && card.cardJson) card.cardJson = stripCardEmoji(card.cardJson);\n    }\n    const embedCard = cards[0];\n    if (embedCard"
expect(old, s, "emoji-tcm-use"); s = s.replace(old, new, 1)
write(p, s)

# ── 2b) embed：monitor.js（finishThinkingStream 跳过已嵌入文本） ──
p = os.path.join(SRC, "monitor.js")
s = read(p)
old = """async function finishThinkingStream(ctx) {
    const { wsClient, frame, state, runtime } = ctx;
    const body = frame.body;"""
new = """async function finishThinkingStream(ctx) {
    const { wsClient, frame, state, runtime } = ctx;
    // ★embed 补丁（2026-08-20）：卡片+文本已作为一条 stream_with_template_card 发出，跳过重复文本
    if (state.embeddedCardSent) {
        runtime.log?.(`[wecom] Final text already embedded with template card, skipping separate text`);
        return;
    }
    const body = frame.body;"""
expect(old, s, "embed-monitor"); s = s.replace(old, new, 1)
write(p, s)

print("✅ 全部补丁应用完成 ->", SRC)
