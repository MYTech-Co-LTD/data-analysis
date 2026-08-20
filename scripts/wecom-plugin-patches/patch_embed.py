import re
base = "/opt/data-analytics-platform/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-cecba9e1975382ec/node_modules/@wecom/wecom-openclaw-plugin/dist/src"

# ========== Patch 1: template-card-manager.js — 嵌入卡片到流式回复 ==========
p1 = base + "/template-card-manager.js"
s = open(p1, encoding="utf-8").read()

# processTemplateCardsIfNeeded: 把 remainingText 传给 sendTemplateCards
old_proc = '''    await sendTemplateCards({ ...params, cards });
    return { remainingText, cardsDetected: true };'''
new_proc = '''    await sendTemplateCards({ ...params, cards, remainingText });
    return { remainingText, cardsDetected: true };'''
assert old_proc in s, "proc anchor missing"
s = s.replace(old_proc, new_proc, 1)

# sendTemplateCards: 首卡嵌入 stream_with_template_card（一条消息），其余卡片走 sendMessage
old_send = '''export async function sendTemplateCards(params) {
    const { wsClient, frame, state, runtime, account, cards } = params;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    for (const card of cards) {'''
new_send = '''export async function sendTemplateCards(params) {
    const { wsClient, frame, state, runtime, account, cards, remainingText } = params;
    const body = frame.body;
    const chatId = body.chatid || body.from.userid;
    // ★嵌入模式（本地补丁 embed-2026-08-20）：首卡与剩余文本作为一条
    //   stream_with_template_card 消息发出（replyStreamWithCard），其余卡片仍单独 sendMessage。
    //   需 wsClient.replyStreamWithCard 存在且卡片类型合法；失败自动回退独立发送。
    const embedCard = cards[0];
    if (embedCard && typeof embedCard.cardJson?.card_type === "string" && wsClient.replyStreamWithCard) {
        try {
            await wsClient.replyStreamWithCard(frame, state.streamId || "stream_embed", remainingText || "", true, {
                templateCard: embedCard.cardJson,
            });
            state.hasTemplateCard = true;
            state.embeddedCardSent = true;
            saveTemplateCardToCache({
                accountId: account.accountId,
                templateCard: embedCard.cardJson,
                runtime,
            });
            runtime.log?.(`[wecom][template-card] Card EMBEDDED in stream reply: card_type=${embedCard.cardType}, remainingTextLen=${(remainingText || "").length}`);
            // 其余卡片（多卡场景）走独立 sendMessage
            for (const card of cards.slice(1)) {
                if (typeof card.cardJson?.card_type !== "string") continue;
                await wsClient.sendMessage(chatId, {
                    msgtype: "template_card",
                    template_card: card.cardJson,
                });
                saveTemplateCardToCache({ accountId: account.accountId, templateCard: card.cardJson, runtime });
            }
            return;
        } catch (err) {
            runtime.error?.(`[wecom][template-card] Embed card failed, fallback to separate send: ${String(err).slice(0, 120)}`);
        }
    }
    for (const card of cards) {'''
assert old_send in s, "send anchor missing"
s = s.replace(old_send, new_send, 1)
open(p1, "w", encoding="utf-8").write(s)
print("patch1 ok")

# ========== Patch 2: monitor.js — finishThinkingStream 跳过已嵌入的文本 ==========
p2 = base + "/monitor.js"
s2 = open(p2, encoding="utf-8").read()
old_finish = '''async function finishThinkingStream(ctx) {
    const { wsClient, frame, state, runtime } = ctx;
    const body = frame.body;'''
new_finish = '''async function finishThinkingStream(ctx) {
    const { wsClient, frame, state, runtime } = ctx;
    // ★嵌入模式（本地补丁 embed-2026-08-20）：卡片+文本已作为一条 stream_with_template_card
    //   消息发出（finish=true），这里跳过，避免重复发送文本。
    if (state.embeddedCardSent) {
        runtime.log?.(`[wecom] Final text already embedded with template card, skipping separate text`);
        return;
    }
    const body = frame.body;'''
assert old_finish in s2, "finish anchor missing"
s2 = s2.replace(old_finish, new_finish, 1)
open(p2, "w", encoding="utf-8").write(s2)
print("patch2 ok")
