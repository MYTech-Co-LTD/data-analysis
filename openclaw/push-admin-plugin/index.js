// openclaw/push-admin-plugin/index.js
// 推送管理插件（plan Task 14 / spec §6.1 push-admin 三层鉴权）：
// 4 工具：list_push_variables / create_push_workflow / create_push_schedule / push_now。
// 照 data-query-plugin 模式：api.registerTool(factory, { name })。
// - name 放第二参数 metadata（运行时注册 + 模型发现都靠它）。
// - factory 每轮调用，从 ctx.requesterSenderId 取可信企微 userid（核心注入，非 LLM 传）。
// - 结构化确认回显（挡 cron 中文歧义 + 双闸插件层兜底）。
// - 服务身份：CASDOOR_CLIENT_ID/SECRET 签 client_credentials JWT（scope: openclaw:push），
//   不持 Novu 凭证（Novu admin 操作走 web push API 代管）。
// - 限速按收件人数计（500 人次/h）+ 单次上限 50（broadcast 豁免上限仍限速）+ 首触发发给自己。
//
// 环境变量（openclaw 容器注入，同 data-query）：
//   PUSH_API_URL — web 内部 push API 地址（默认 http://web:3000/api/push）
//   CASDOOR_ORIGIN / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET — client_credentials 签 JWT
//   AGENT_API_KEY — 网关密钥（复用 data-query 同款）

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PUSH_API_URL =
  process.env.PUSH_API_URL || "http://web:3000/api/push";
const CASDOOR_ORIGIN =
  process.env.CASDOOR_ORIGIN || "https://sso.shanhaiyiguo.com";
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || "";
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || "";

// ===== client_credentials JWT 管理（60s 前置刷新） =====
// spec §6.1：服务身份 client_credentials 短时 JWT（scope: openclaw:push，60s 前置刷新）

let cachedToken = null;
let cachedTokenExpiresAt = 0;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

async function getServiceJwt() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken;
  }

  if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
    throw new Error(
      "Casdoor client credentials not configured (CASDOOR_CLIENT_ID/SECRET)",
    );
  }

  const resp = await fetch(`${CASDOOR_ORIGIN}/api/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CASDOOR_CLIENT_ID,
      client_secret: CASDOOR_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Casdoor token fetch failed: HTTP ${resp.status}`);
  }

  const body = await resp.json();
  if (!body.access_token) {
    throw new Error("Casdoor token response missing access_token");
  }

  cachedToken = body.access_token;
  cachedTokenExpiresAt = now + ((body.expires_in || 7200) * 1000);
  return cachedToken;
}

// ===== push API 调用封装 =====

async function callPushApi(body) {
  const token = await getServiceJwt();
  let resp;
  try {
    resp = await fetch(PUSH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "push API 不可达：" + ((e && e.message) || String(e)) };
  }

  let result = {};
  try { result = await resp.json(); } catch { result = {}; }

  if (!resp.ok || result.ok !== true) {
    return {
      ok: false,
      error: result.error || "push API HTTP " + resp.status,
      detail: result.detail,
    };
  }
  return result;
}

// ===== 工具定义 =====

// 1. list_push_variables：列出可用推送变量
const LIST_VARS_NAME = "list_push_variables";
const LIST_VARS_DESC =
  "列出所有可推送的业务变量（如 sale_amount/achievement_rate 等）。" +
  "建 workflow 前调一次，了解能用哪些变量。返回 var_code/name/scope_dim/unit。" +
  "所有登录用户可调。";
const LIST_VARS_PARAMS = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

// 2. create_push_workflow：创建 Novu 推送模板
const CREATE_WF_NAME = "create_push_workflow";
const CREATE_WF_DESC =
  "创建一个推送模板（Novu workflow）。" +
  "需要 push:configure 权限。传 name（模板名）、description（模板描述/用途说明）、" +
  "variables（变量 code 列表，从 list_push_variables 获取）。" +
  "返回 workflow_id（后续 push_now/create_push_schedule 使用）。" +
  "请用中文描述模板用途，方便管理。";
const CREATE_WF_PARAMS = {
  type: "object",
  properties: {
    name: { type: "string", description: "模板名称，如「战区达成率日报」" },
    description: { type: "string", description: "模板用途描述，如「每天推送给战区总，含销售/配送/出库三指标」" },
    variables: {
      type: "array",
      items: { type: "string" },
      description: "变量 code 列表，从 list_push_variables 获取。如 ['sale_amount', 'achievement_rate']",
    },
  },
  required: ["name", "description", "variables"],
  additionalProperties: false,
};

// 3. create_push_schedule：创建定时推送
// B8（review 修复）：本工具半成品——返回「确认回显」后无任何持久化分支
// （params 无 confirm 字段，schedule_spec 只作提示），且持久化目标
// （scheduled_reports binding + OpenClaw cron）属 U7 定时链路，尚未落地
// （get_due_scheduled_reports 无 migration，scheduled_reports 无 selector 列）。
// 与 selector.kind='role' 的「pending U2」同款处理：fail-closed 冻结，不给假承诺；
// 指引用户走已可用的 push_now。U7 上线后随推送中心一并开放。
const CREATE_SCHED_NAME = "create_push_schedule";
const CREATE_SCHED_DESC =
  "创建定时推送计划（cron 调度）。" +
  "【暂不可用】U7 统一推送中心定时链路（OpenClaw cron → scheduled_reports 绑定 → run_push 引擎）" +
  "尚未落地，本工具冻结，调用即返回错误。" +
  "当前定时推送请用 push_now（立即推送）+ 外部调度；U7 上线后本工具自动开放。";
const CREATE_SCHED_PARAMS = {
  type: "object",
  properties: {
    workflow_id: { type: "string", description: "create_push_workflow 返回的 workflow_id" },
    name: { type: "string", description: "定时计划名称，如「每天 08:00 战区达成率日报」" },
    schedule: {
      type: "object",
      description: "cron 调度：{kind:'cron', expr:'0 8 * * *', tz:'Asia/Shanghai'}",
      properties: {
        kind: { type: "string", enum: ["cron", "every", "at"] },
        expr: { type: "string" },
        tz: { type: "string" },
        everyMs: { type: "number" },
        at: { type: "string" },
      },
    },
    selector: {
      type: "object",
      description: "收件人 selector：只接受 {kind:'dept'|'person'|'all', ids?:string[]}。不接受手写收件人列表。",
      properties: {
        kind: { type: "string", enum: ["dept", "person", "all"] },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
    },
    variables: {
      type: "array",
      items: { type: "string" },
      description: "本次推送使用的变量 code 列表（可选，不传用 workflow 默认）",
    },
  },
  required: ["workflow_id", "name", "schedule", "selector"],
  additionalProperties: false,
};

// 4. push_now：立即推送
const PUSH_NOW_NAME = "push_now";
const PUSH_NOW_DESC =
  "立即触发一次推送。需要 push:configure 权限；全员推送额外需要 push:broadcast。" +
  "selector 只接受组织维（dept/person/all），不接受手写收件人列表。" +
  "单次最多 50 收件人（broadcast 豁免上限仍限速）。" +
  "返回确认回显（结构化：workflow/selector/estimated recipients），需用户确认后发送。" +
  "首次触发将自动发送给操作者本人（安全门）。";
const PUSH_NOW_PARAMS = {
  type: "object",
  properties: {
    workflow_id: { type: "string", description: "create_push_workflow 返回的 workflow_id" },
    selector: {
      type: "object",
      description: "收件人 selector：只接受 {kind:'dept'|'person'|'all', ids?:string[]}。不接受手写收件人列表。",
      properties: {
        kind: { type: "string", enum: ["dept", "person", "all"] },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["kind"],
    },
    variables: {
      type: "array",
      items: { type: "string" },
      description: "本次推送使用的变量 code 列表（可选）",
    },
  },
  required: ["workflow_id", "selector"],
  additionalProperties: false,
};

// ===== 插件注册 =====

export default definePluginEntry({
  id: "push-admin",
  name: "Push Admin",
  description:
    "推送管理插件：通过中文对话自助配置 Novu 推送模板、定时计划和即时推送。" +
    "三层鉴权（服务 JWT + 人员权限 + 引擎闸），收件人只接受组织维 selector。",
  register(api) {
    // 首次调用诊断
    if (!globalThis.__PUSH_ADMIN_DIAG) {
      globalThis.__PUSH_ADMIN_DIAG = 1;
      console.log(
        "[push-admin] diag pushApiUrl=" + PUSH_API_URL +
        " casdoorOrigin=" + CASDOOR_ORIGIN +
        " hasClientId=" + (!!CASDOOR_CLIENT_ID),
      );
    }

    // 1. list_push_variables
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: LIST_VARS_NAME,
          description: LIST_VARS_DESC,
          parameters: LIST_VARS_PARAMS,
          execute: async () => {
            if (!userId) return { error: "无法识别请求者身份（requesterSenderId 缺失）" };
            // B4：子路由需人员身份（push API 按 userId 鉴权 push:configure）
            const result = await callPushApi({ action: "list_variables", userId });
            if (!result.ok) return result;
            return {
              ok: true,
              variables: result.variables,
              count: Array.isArray(result.variables) ? result.variables.length : 0,
            };
          },
        };
      },
      { name: LIST_VARS_NAME },
    );

    // 2. create_push_workflow
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: CREATE_WF_NAME,
          description: CREATE_WF_DESC,
          parameters: CREATE_WF_PARAMS,
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : (params || {});
            if (!userId) return { error: "无法识别请求者身份（requesterSenderId 缺失）" };

            // 插件层校验
            if (!obj.name) return { error: "name required" };
            if (!obj.description) return { error: "description required" };
            if (!Array.isArray(obj.variables) || obj.variables.length === 0) {
              return { error: "variables required (from list_push_variables)" };
            }

            const result = await callPushApi({
              action: "create_workflow",
              workflowName: obj.name,
              workflowDescription: obj.description,
              userId,
            });

            if (!result.ok) return result;

            // 结构化确认回显
            return {
              ok: true,
              workflow_id: result.workflow && result.workflow.id,
              workflow_name: obj.name,
              description: obj.description,
              variables: obj.variables,
              message: `已创建推送模板「${obj.name}」（workflow_id: ${result.workflow && result.workflow.id}）。` +
                `变量: ${obj.variables.join(', ')}。` +
                `后续用 push_now 或 create_push_schedule 触发推送。`,
            };
          },
        };
      },
      { name: CREATE_WF_NAME },
    );

    // 3. create_push_schedule（B8 冻结：U7 定时链路未落地，fail-closed，不假确认回显）
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: CREATE_SCHED_NAME,
          description: CREATE_SCHED_DESC,
          parameters: CREATE_SCHED_PARAMS,
          execute: async () => {
            if (!userId) return { error: "无法识别请求者身份（requesterSenderId 缺失）" };
            // B8：无持久化目标（U7 定时链路未落地）→ 明确拒绝，不给「确认后创建」的假承诺。
            return {
              ok: false,
              error: "create_push_schedule 暂不可用：U7 统一推送中心定时链路未落地，调用后端不会持久化任何计划。" +
                "当前请用 push_now 立即推送（可配外部调度触发）；U7 上线后本工具跟随开放。",
              available_alternatives: ["push_now"],
            };
          },
        };
      },
      { name: CREATE_SCHED_NAME },
    );

    // 4. push_now
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: PUSH_NOW_NAME,
          description: PUSH_NOW_DESC,
          parameters: PUSH_NOW_PARAMS,
          execute: async (_id, params) => {
            const obj = typeof params === "string" ? JSON.parse(params) : (params || {});
            if (!userId) return { error: "无法识别请求者身份（requesterSenderId 缺失）" };

            // 插件层校验：selector 只接受组织维
            const sel = obj.selector;
            if (!sel || !sel.kind) return { error: "selector.kind required" };
            if (!["dept", "person", "all"].includes(sel.kind)) {
              return { error: "selector.kind must be dept/person/all（不接受手写收件人列表）" };
            }
            if (sel.kind !== "all" && (!Array.isArray(sel.ids) || sel.ids.length === 0)) {
              return { error: `selector.kind=${sel.kind} requires non-empty ids array` };
            }
            if (!obj.workflow_id) return { error: "workflow_id required" };

            // 单次上限 50 预检
            if (sel.kind !== "all" && Array.isArray(sel.ids) && sel.ids.length > 50) {
              return { error: `单次最多 50 收件人（当前 ${sel.ids.length}）。broadcast selector 豁免上限。` };
            }

            const result = await callPushApi({
              workflowId: obj.workflow_id,
              selector: sel,
              variables: obj.variables,
              userId,
            });

            if (!result.ok) return result;

            // 结构化确认回显
            const selDisplay = sel.kind === "all"
              ? "全员"
              : `${sel.kind}=[${(sel.ids || []).join(', ')}]`;

            return {
              ok: true,
              txnId: result.txnId,
              groups: result.groups,
              skipped: result.skipped,
              firstTrigger: result.firstTrigger,
              message: result.firstTrigger
                ? `首次触发已发送给你本人（txnId: ${result.txnId}）。确认内容无误后，再次 push_now 将发送给 ${selDisplay}。`
                : `推送已触发（txnId: ${result.txnId}，${result.groups} 组，${(result.skipped || []).length} 人跳过）。`,
            };
          },
        };
      },
      { name: PUSH_NOW_NAME },
    );
  },
});
