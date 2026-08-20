// openclaw/data-query-plugin/dist/index.js
// 零售数据查询工具（架构文档 docs/architecture.md §4.3）。
//
// 注册形式对齐同实例已验证的 wecom 插件：api.registerTool(factory, { name })。
// - name 放第二参数 metadata（运行时注册 + 模型发现都靠它；放 factory 返回里会被判 malformed）。
// - factory 每轮调用，从 ctx.requesterSenderId 取可信企微 userid（核心注入，非 LLM 传；
//   远程 MCP 拿不到 → 必须用 native plugin）。execute 闭包捕获当轮 userId。
// - userid + SQL 转发 agent-query 网关（§4.2）做按人鉴权。AGENT_API_KEY 留容器 env 不进 LLM。
//
// 依赖：仅 openclaw 运行时（definePluginEntry 由 loader 解析）。无 typebox 等 npm 依赖。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";

const GATEWAY_URL =
  process.env.AGENT_QUERY_URL || "http://insforge:7130/functions/agent-query";
const NOTIFY_URL =
  process.env.NOTIFY_URL || "http://insforge:7130/functions/wecom-notify";
const MAX_ROWS_TO_MODEL = 50;

// ===== 服务身份 JWT（U1b：agent-query 鉴权收敛，scope openclaw:query）=====
// 容器配了 CASDOOR_CLIENT_ID/SECRET（同 push-admin）→ client_credentials 换短时 JWT
// 附 Authorization: Bearer；未配置/换不到 → 回落 body.agent_api_key（过渡期双通道）。
// 60s 前置刷新，缓存复用（与 push-admin-plugin 同款）。
const CASDOOR_ORIGIN = process.env.CASDOOR_ORIGIN || "https://sso.shanhaiyiguo.com";
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || "";
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || "";
let cachedSvcToken = null;
let cachedSvcTokenExpiresAt = 0;
const SVC_TOKEN_MARGIN_MS = 60 * 1000;

async function getServiceJwt() {
  if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) return null;
  const now = Date.now();
  if (cachedSvcToken && now < cachedSvcTokenExpiresAt - SVC_TOKEN_MARGIN_MS) {
    return cachedSvcToken;
  }
  try {
    const resp = await fetch(`${CASDOOR_ORIGIN}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: CASDOOR_CLIENT_ID,
        client_secret: CASDOOR_CLIENT_SECRET,
        scope: "openclaw:query",
      }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const body = await resp.json();
    if (!body.access_token) throw new Error("no access_token");
    cachedSvcToken = body.access_token;
    cachedSvcTokenExpiresAt = now + (body.expires_in || 7200) * 1000;
    return cachedSvcToken;
  } catch (e) {
    console.warn("[data-query] service JWT fetch failed, fallback to shared key:", String(e));
    return null;
  }
}

// 网关调用公共头：JWT 可得则 Authorization Bearer（不含 agent_api_key，防降级歧义）；
// 否则 body 补 agent_api_key（旧通道）。
async function gatewayHeadersAndBody(body) {
  const token = await getServiceJwt();
  if (token) {
    return { headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) };
  }
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, agent_api_key: process.env.AGENT_API_KEY }) };
}

// ★U1c 修复（2026-08-20）：模块级 userId 兜底——同一轮后续工具调用若 ctx.requesterSenderId 为空，复用首个捕获值
let lastUserId = "";

const TOOL_NAME = "query_retail_data";
const TOOL_DESC =
  "查询零售销售数据。可直接查明细视图 retail_detail（乐檬 POS 订单明细），" +
  "或查汇总表 report_daily_sales / report_daily_category / report_weekly_trend。" +
  "只允许 SELECT。门店与成本列按当前用户权限自动过滤/脱敏，无需也不能在 SQL 里写权限条件。" +
  "调用前请参考 retail-query skill 了解可用列与写法。";
const TOOL_PARAMS = {
  type: "object",
  properties: {
    sql: {
      type: "string",
      description:
        "单条 SELECT 语句。明细查 retail_detail，汇总查 report_* 表。不要写 read_parquet/DDL/DML。无 LIMIT 时网关自动补 LIMIT 1000。",
    },
  },
  required: ["sql"],
  additionalProperties: false,
};

// ===== list_datasets 工具：拉活字典（数据集/列/敏感度/JOIN提示/日期列）=====
const LIST_TOOL_NAME = "list_datasets";
const LIST_TOOL_DESC =
  "列出当前可查的数据集（明细/汇总/维表）及其列、成本敏感标记、JOIN 提示、日期列与格式。" +
  "会话首次查询前调一次，了解能用哪些表/列、哪些列成本敏感（无权限会返回 NULL）。" +
  "可用表/列以此返回为准，勿凭记忆。";
const LIST_TOOL_PARAMS = { type: "object", properties: {}, additionalProperties: false };

async function fetchDictionary(userId) {
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!agentApiKey) return { error: "网关密钥未配置（openclaw 容器缺 AGENT_API_KEY env）。" };
  let resp;
  try {
    const { headers, body: reqBody } = await gatewayHeadersAndBody(
      { mode: "dictionary", userId },
    );
    resp = await fetch(GATEWAY_URL, { method: "POST", headers, body: reqBody });
  } catch (e) {
    return { error: "查询网关不可达：" + ((e && e.message) || String(e)) };
  }
  let body = {};
  try { body = await resp.json(); } catch { body = {}; }
  if (!resp.ok || body.success !== true) return { error: body.error || "网关返回 HTTP " + resp.status };
  return body.dictionary;
}

// ===== C4 定时应用：create_scheduled_report（写绑定）+ push_report（强制 delivery_to 推送）=====
const CREATE_SR_NAME = "create_scheduled_report";
const CREATE_SR_PARAMS = {
  type: "object",
  properties: {
    name: { type: "string" },
    schedule: { type: "object", description: "cron 调度：每天9点={kind:'cron',expr:'0 9 * * *',tz:'Asia/Shanghai'}；每小时={kind:'every',everyMs:3600000}；一次性={kind:'at',at:'<ISO 8601>'}" },
    sr_mode: { type: "string", enum: ["template", "sql"], description: "template=标准报表模板; sql=自然语言查询" },
    template_key: { type: "string" },
    query_intent: { type: "string" },
  },
  required: ["name", "schedule", "sr_mode"],
  additionalProperties: false,
};
const PUSH_NAME = "push_report";
const PUSH_PARAMS = {
  type: "object",
  properties: {
    content: { type: "string", description: "推送正文（markdown）" },
    title: { type: "string" },
  },
  required: ["content"],
  additionalProperties: false,
};

async function gatewayPost(body) {
  const { headers, body: reqBody } = await gatewayHeadersAndBody(body);
  const resp = await fetch(GATEWAY_URL, { method: "POST", headers, body: reqBody });
  return resp.json().catch(() => ({}));
}

async function pushNotify({ to, content, title }) {
  const resp = await fetch(NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_api_key: process.env.AGENT_API_KEY, content, title, touser: to, msgtype: "markdown" }),
  });
  return resp.json().catch(() => ({}));
}

async function executeQuery({ sql }, userId, cronSessionKey) {
  const agentApiKey = process.env.AGENT_API_KEY;

  if (!agentApiKey) {
    return {
      error: "网关密钥未配置（openclaw 容器缺 AGENT_API_KEY env），请联系管理员。",
    };
  }
  // eslint-disable-next-line no-console
  if (process.env.DQ_DEBUG === '1') console.log(`[data-query] exec sqlLen=${(sql||'').length} userId=${JSON.stringify(userId)} cron=${JSON.stringify(cronSessionKey)}`);
  if (!userId && !cronSessionKey) {
    return {
      error: "无法识别请求者身份（requesterSenderId 和 cronSessionKey 都缺失），出于权限安全不予查询。",
    };
  }

  let resp;
  try {
    const { headers, body: reqBody } = await gatewayHeadersAndBody(
      cronSessionKey ? { sql, cronSessionKey } : { sql, userId },
    );
    resp = await fetch(GATEWAY_URL, { method: "POST", headers, body: reqBody });
  } catch (e) {
    return { error: "查询网关不可达：" + ((e && e.message) || String(e)) };
  }

  let body = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }

  if (!resp.ok || body.success !== true) {
    const rule = body.rule || undefined;
    let hint;
    if (rule === "only_select_allowed") hint = "只允许 SELECT 语句。";
    else if (rule && String(rule).startsWith("forbidden_statement"))
      hint =
        "该关键词被禁止（" + rule + "）。明细请查 retail_detail 视图，不要用 read_parquet。";
    else if (body.error === "no_permission") hint = "你当前没有数据查询权限。";
    else if (rule === "forbidden_branch_join" || rule === "forbidden_cross_join")
      hint = "join 维表必须用复合键：ON rd.system_book_code = db.system_book_code AND rd.branch_num = db.branch_num（禁止裸 branch_num join，会跨品牌串号）。区域聚合可直接 GROUP BY retail_detail 自带的 region_name，无需 join。";
    else if (rule === "forbidden_string_table" || rule === "forbidden_file_reference" || rule === "forbidden_table_function")
      hint = "禁止直接引用文件或表函数。只能查 retail_detail / report_* / dim_* 这些权限视图。";
    else if (rule && String(rule).startsWith("forbidden_table:"))
      hint = "表 " + String(rule).split(":")[1] + " 不在可查范围。可用表/列请先调 list_datasets 确认。";
    return { error: body.error || "网关返回 HTTP " + resp.status, rule, hint };
  }

  const data = Array.isArray(body.data) ? body.data : [];
  const trimmed = data.slice(0, MAX_ROWS_TO_MODEL);
  return {
    engine: body.engine,
    rowCount: body.rowCount != null ? body.rowCount : data.length,
    perms: body.perms,
    rows: trimmed,
    truncated: data.length > MAX_ROWS_TO_MODEL,
    note:
      data.length > MAX_ROWS_TO_MODEL
        ? "仅返回前 " +
          MAX_ROWS_TO_MODEL +
          " 行（共 " +
          data.length +
          " 行）。如需精确数字请用聚合（count/sum），或加 LIMIT。"
        : undefined,
  };
}

export default definePluginEntry({
  id: "data-query",
  name: "Retail Data Query",
  description:
    "零售数据查询：携带可信企微 userid 转发到 agent-query 网关，按用户权限返回零售明细与汇总表。",
  register(api) {
    api.registerTool(
      (ctx) => {
        const userId = (ctx && ctx.requesterSenderId) || lastUserId;
        if (userId) lastUserId = userId;
        // 首次调用打一行诊断（确认 sender 注入路径）。
        if (!globalThis.__DQ_DIAG) {
          globalThis.__DQ_DIAG = 1;
          // eslint-disable-next-line no-console
          console.log(
            "[data-query] diag ctxKeys=" +
              (ctx ? Object.keys(ctx).join(",") : "none") +
              " userId=" +
              (userId || "<empty>") +
              " gateway=" +
              GATEWAY_URL,
          );
        }
        return {
          name: TOOL_NAME,
          description: TOOL_DESC,
          parameters: TOOL_PARAMS,
          // execute 签名实测定稿（agent-tools.before-tool-call.js:1510）：
          //   execute(toolCallId, params, signal, onUpdate)
          // 第一个参数是 toolCallId（字符串"id"），第二个才是模型传的参数对象。
          // 之前误写成 (args) => 把 toolCallId 当成 params，导致 sql 恒为 undefined
          // → 网关收到无 sql 的 body → "missing sql/userId"（每次必现，非编造）。
          // 这里兼容 params 为对象 / JSON 字符串 / 包一层 input|arguments|parameters。
          execute: (toolCallId, params, _signal, _onUpdate) => {
            let raw = params;
            if (typeof raw === "string") {
              try {
                raw = JSON.parse(raw);
              } catch {
                raw = { sql: raw };
              }
            }
            const obj = raw && typeof raw === "object" ? raw : {};
            const sql =
              obj.sql ??
              (obj.input && obj.input.sql) ??
              (obj.arguments && obj.arguments.sql) ??
              (obj.parameters && obj.parameters.sql);
            if (!globalThis.__DQ_EXEC_DIAG) {
              globalThis.__DQ_EXEC_DIAG = 1;
              // eslint-disable-next-line no-console
              console.log(
                "[data-query] exec diag toolCallId=" +
                  (toolCallId || "<empty>") +
                  " paramsType=" +
                  (params === undefined ? "undef" : typeof params) +
                  " paramsKeys=" +
                  (obj && typeof obj === "object"
                    ? Object.keys(obj).join(",")
                    : "<n/a>") +
                  " sqlLen=" +
                  (sql ? sql.length : 0) +
                  " userId=" +
                  (userId || "<empty>"),
              );
            }
            const cronSessionKey = ctx && ctx.sessionKey; // C4: cron turn 透传（userId 空时 agent-query 反查 run_as）
            return executeQuery({ sql }, userId, userId ? null : cronSessionKey);
          },
        };
      },
      { name: TOOL_NAME },
    );

    // list_datasets：拉活字典（转发 agent-query 的 dictionary 模式）
    api.registerTool(
      (ctx) => {
        const userId = (ctx && ctx.requesterSenderId) || lastUserId;
        if (userId) lastUserId = userId;
        return {
          name: LIST_TOOL_NAME,
          description: LIST_TOOL_DESC,
          parameters: LIST_TOOL_PARAMS,
          execute: () => fetchDictionary(userId),
        };
      },
      { name: LIST_TOOL_NAME },
    );

    // C4 create_scheduled_report：一步建 cron（callGatewayTool）+ 写绑定。避免 agent 协调多 tool 漏调（实测踩过：LLM 只建 cron 漏 create_scheduled_report）。
    api.registerTool(
      (ctx) => {
        const owner = ctx && ctx.requesterSenderId;
        return {
          name: CREATE_SR_NAME,
          description: "建定时推送应用（一步：内部建 cron + 写绑定）。传 name/schedule/sr_mode(template|sql)/template_key 或 query_intent。run_as/delivery_to 钉死=你本人。cron 触发时 agent 按 query_intent/template 用 query_retail_data 查（自动按你的权限）+ push_report 推给你。不要手动用 cron 工具建。",
          parameters: CREATE_SR_PARAMS,
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : (params || {});
            if (!owner) return { error: "无法识别创建者（非会话上下文）" };
            const message = obj.sr_mode === "template"
              ? `执行报表模板 ${obj.template_key}：用 query_retail_data 查数据，再用 push_report 推送结果`
              : `查询：${obj.query_intent}。用 query_retail_data 查数据，再用 push_report 推送结果`;
            let job;
            try {
              job = await callGatewayTool("cron.add", {}, {
                name: obj.name, schedule: obj.schedule, sessionTarget: "isolated",
                payload: { kind: "agentTurn", message }, delivery: { mode: "none" },
              });
            } catch (e) { return { error: "cron 创建异常", detail: String(e) }; }
            const cronJobId = job && (job.id || job.job_id || (job.job && job.job.id));
            if (!cronJobId) return { error: "cron 创建失败（无 job id）", detail: JSON.stringify(job).slice(0, 300) };
            const upsert = await gatewayPost({ mode: "upsert_scheduled", userId: owner, cron_job_id: cronJobId, name: obj.name, sr_mode: obj.sr_mode, template_key: obj.template_key, query_intent: obj.query_intent });
            return { success: true, cron_job_id: cronJobId, scheduled_report_id: upsert && upsert.id, message: `已建定时应用「${obj.name}」，按你的权限查并推送给你` };
          },
        };
      },
      { name: CREATE_SR_NAME },
    );

    // C4 push_report：cron turn 推送。cron_job_id 从 ctx.sessionKey 可信 parse（不信参数）；收件人强制绑定查。
    api.registerTool(
      (ctx) => {
        return {
          name: PUSH_NAME,
          description: "推送定时报表（cron turn 里查完数据后调）。收件人强制从绑定查（cron_job_id→delivery_to），不信参数里的收件人。job_id 从当前 cron session 自动取。",
          parameters: PUSH_PARAMS,
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : (params || {});
            const m = ((ctx && ctx.sessionKey) || "").match(/cron:([^:]+)/);
            const cronJobId = m ? m[1] : null;
            if (!cronJobId) return { error: "无法识别当前 cron job（sessionKey 无 cron:<jobid>，非 cron turn？）" };
            const lookup = await gatewayPost({ mode: "lookup_delivery", cron_job_id: cronJobId });
            const to = lookup.delivery_to;
            if (!to) return { error: "未找到该 cron job 的定时应用绑定（delivery_to）" };
            return pushNotify({ to, content: obj.content, title: obj.title });
          },
        };
      },
      { name: PUSH_NAME },
    );

    // C4 delete_scheduled_report：删自己的定时应用（绑定 + cron job，防孤儿）
    api.registerTool(
      (ctx) => {
        const owner = ctx && ctx.requesterSenderId;
        return {
          name: "delete_scheduled_report",
          description: "删除自己的定时推送应用（删绑定 + OpenClaw cron job）。传建时返回的 cron_job_id。只能删自己的。",
          parameters: { type: "object", properties: { cron_job_id: { type: "string" } }, required: ["cron_job_id"], additionalProperties: false },
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : (params || {});
            if (!owner) return { error: "无法识别身份" };
            const del = await gatewayPost({ mode: "delete_scheduled", userId: owner, cron_job_id: obj.cron_job_id });
            if (del.result !== "deleted") return { error: "删除失败（不存在或非本人）", detail: del };
            try { await callGatewayTool("cron.remove", {}, { id: obj.cron_job_id }); } catch (e) { /* cron 删失败不阻塞：绑定已删，cron 触发反查失败不推送 */ }
            return { success: true, message: "已删除定时应用（绑定+cron job）" };
          },
        };
      },
      { name: "delete_scheduled_report" },
    );
  },
});
