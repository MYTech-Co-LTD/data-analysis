// functions/journal-push/index.js
// 日报推送流水线（全确定性，无 LLM）：轮询企微「汇报」应用 → 区域经理复盘日报
// → 反查战区 → 系统真实销售/达标率 → 群机器人 webhook。
//
// 触发：服务器 crontab 每 10 分钟 POST 本 function（header: x-agent-key）。
// 背景（2026-09-04 实测）：企微「汇报」无提交回调事件（App B 回调端点实测零推送），
// 只有拉取式 API：oa/journal/get_record_list + get_record_detail。
//
// env（function secrets）：
//   AGENT_API_KEY            鉴权（与 openclaw/网关同值）
//   WECOM_CORP_ID            企微企业 ID
//   WECOM_OPS_SECRET         App B secret（需在后台「汇报」应用里授权 API 调用）
//   JOURNAL_PUSH_WEBHOOK_URL 群机器人 webhook 完整 URL
//   POSTGREST_BASE_URL       默认 http://postgrest:3000
//
// 数据依赖（migration 211 + 既有结构）：
//   journal_push_seen / journal_push_state（水位）
//   journal_war_zone_month_sales（战区当月真实销售额视图）
//   org_users.role_codes（提交人 → 「范围|XX战区」）
//   模板白名单：区域经理复盘日报（template_id 硬编码，见下）

const AGENT_API_KEY = Deno.env.get("AGENT_API_KEY") || "";
const CORP_ID = Deno.env.get("WECOM_CORP_ID") || "";
const OPS_SECRET = Deno.env.get("WECOM_OPS_SECRET") || "";
const WEBHOOK_URL = Deno.env.get("JOURNAL_PUSH_WEBHOOK_URL") || "";
const POSTGREST_URL = Deno.env.get("POSTGREST_BASE_URL") || "http://postgrest:3000";

// 「区域经理复盘日报」模板（2026-09-04 从实测记录 get_record_detail 读取）
const TEMPLATE_IDS = new Set(["3WN5uZiSaGW5VLdZtFiKHAjnfGHA1Lr2spcetkFN"]);
const TEMPLATE_NAME = "区域经理复盘日报";

// ---------- 基础工具 ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function qyPost(path, body) {
  const tokUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${OPS_SECRET}`;
  const tokRes = await (await fetch(tokUrl)).json();
  if (!tokRes.access_token) throw new Error("gettoken failed: " + JSON.stringify(tokRes));
  const res = await (
    await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/${path}?access_token=${tokRes.access_token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    )
  ).json();
  return res;
}

async function pgrest(path) {
  const res = await fetch(`${POSTGREST_URL}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`postgrest ${path} -> ${res.status}`);
  return res.json();
}

// 日报里区域经理手填的关键字段抽取
function extractFields(applyData) {
  const out = {};
  for (const c of applyData?.contents || []) {
    const title = c?.title?.[0]?.text || "";
    const text = c?.value?.text || "";
    if (title) out[title] = text;
  }
  return out;
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

// 「范围|东部战区」/「branch:东部战区」→ 东部战区
function extractWarZone(roleCodes) {
  for (const rc of roleCodes || []) {
    const m = String(rc).match(/范围\|(.+战区)$/);
    if (m) return m[1];
  }
  return null;
}

// ---------- 主流程 ----------
module.exports = async function request(request) {
  if (request.method === "GET") {
    return json({ service: "journal-push", status: "ok" });
  }

  // 鉴权：crontab 带 x-agent-key
  const key = request.headers.get("x-agent-key") || "";
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    return json({ error: "unauthorized" }, 401);
  }

  if (!CORP_ID || !OPS_SECRET) return json({ error: "missing WECOM_CORP_ID/WECOM_OPS_SECRET" }, 500);
  if (!WEBHOOK_URL) return json({ error: "missing JOURNAL_PUSH_WEBHOOK_URL" }, 500);

  // ① 水位
  const stateRows = await pgrest(`/journal_push_state?key=eq.record_watermark&select=value`);
  let watermark = Number(stateRows?.[0]?.value || 0);
  const now = Math.floor(Date.now() / 1000);
  // 首次运行：从 24h 前开始兜底（正常情况下水位由上一次运行推进）
  const startTime = watermark > 0 ? watermark : now - 86400;

  // ② 拉新汇报记录（窗口 ≤ 30 天，这里 10 分钟步长）
  const listRes = await qyPost("oa/journal/get_record_list", {
    starttime: startTime,
    endtime: now,
    cursor: 0,
    limit: 100,
  });
  if (listRes.errcode !== 0) return json({ error: "get_record_list failed", detail: listRes }, 502);
  const uuids = listRes.journaluuid_list || [];

  const processed = [];
  const skipped = [];

  for (const uuid of uuids) {
    // 已处理过 → 跳过（防重）
    const seen = await pgrest(`/journal_push_seen?journaluuid=eq.${uuid}&select=journaluuid`);
    if (seen.length > 0) continue;

    // ③ 详情
    const detail = await qyPost("oa/journal/get_record_detail", { journaluuid: uuid });
    if (detail.errcode !== 0 || !detail.info) {
      skipped.push({ uuid, reason: "detail_failed" });
      continue;
    }
    const info = detail.info;
    if (!TEMPLATE_IDS.has(info.template_id)) {
      skipped.push({ uuid, reason: "template_not_matched", tpl: info.template_name });
      await markSeen(uuid, info, null);
      continue;
    }

    const userid = info.submitter?.userid || "";
    const fields = extractFields(info.apply_data);

    // ④ 提交人 → 战区
    const users = await pgrest(
      `/org_users?wecom_id=eq.${encodeURIComponent(userid)}&select=name,role_codes&is_active=eq.true`,
    );
    const user = users?.[0];
    const warZone = user ? extractWarZone(user.role_codes) : null;
    if (!warZone) {
      skipped.push({ uuid, reason: "war_zone_not_found", userid });
      await markSeen(uuid, info, null);
      continue;
    }

    // ⑤ 系统真实数：该战区当月销售额
    const sales = await pgrest(
      `/journal_war_zone_month_sales?war_zone=eq.${encodeURIComponent(warZone)}&select=month_sales,store_count,latest_biz_date`,
    );
    const real = sales?.[0] || {};
    const realSales = Number(real.month_sales || 0);

    // ⑥ 组装消息（日报手填 vs 系统实际）
    const targetText = fields["区域月度销售目标（元）"] || "";
    const target = Number(String(targetText).replace(/[^\d.]/g, "")) || 0;
    const rate = target > 0 ? ((realSales / target) * 100).toFixed(1) : null;
    const daysElapsed = Math.max(1, new Date().getDate());
    const daysTotal = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const timeProgress = ((daysElapsed / daysTotal) * 100).toFixed(1);

    const md = [
      `## 📋 ${TEMPLATE_NAME} · ${warZone}`,
      `**提交人**：<@${userid}> ｜ ${user?.name || userid}`,
      "",
      "| 指标 | 日报填报 | 系统实际 |",
      "|---|---|---|",
      `| 月度销售目标 | ${targetText || "—"} 元 | — |`,
      `| 截止今日销售额 | ${fields["截止今日完成销售额（元）"] || "—"} 元 | **${fmtMoney(realSales)} 元** |`,
      `| 月度达成率 | ${fields["月度目标销售达成率（元）"] || "—"}% | ${rate ? `**${rate}%**` : "（目标未填，无法计算）"} |`,
      `| 月度出库完成率 | ${fields["月度出库完成率（%）"] || "—"}% | 待接指标 |`,
      "",
      `> 系统实际 = ${warZone} ${real.store_count ?? "?"} 家门店当月零售销售额（截至 ${real.latest_biz_date ?? "最新业务日"}）`,
      `> 月度时间进度：**${timeProgress}%**（${daysElapsed}/${daysTotal} 天）`,
      "",
      `**今日客单量**：${fields["区域当日客单量（单）"] || "—"} ｜ **当日目标达成率**：${fields["区域当日目标销售额达成率（%）"] || "—"}`,
      `**倒数5名门店**：${fields["区域当日销售额倒数5名的门店（门店➕业绩）"] || "—"}`,
    ].join("\n");

    // ⑦ 群机器人推送
    const hookRes = await (
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: md } }),
      })
    ).json();

    await markSeen(uuid, info, warZone);
    processed.push({ uuid, userid, warZone, realSales, hookErrcode: hookRes.errcode });
  }

  // ⑧ 推进水位
  await fetch(`${POSTGREST_URL}/journal_push_state?key=eq.record_watermark`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ value: String(now), updated_at: new Date().toISOString() }),
  });

  return json({
    ok: true,
    scanned: uuids.length,
    processed: processed.length,
    detail: processed,
    skipped,
    window: { from: startTime, to: now },
  });
}

async function markSeen(uuid, info, warZone) {
  await fetch(`${POSTGREST_URL}/journal_push_seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      journaluuid: uuid,
      submitter: info?.submitter?.userid || null,
      war_zone: warZone,
    }),
  });
}
