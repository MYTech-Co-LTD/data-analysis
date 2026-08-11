// functions/agent-query/index.js
// 智能问数网关（架构文档 docs/architecture.md §4.2）
// 链路：① 认证(AGENT_API_KEY) → ② 授权(get_user_perms 取 branch_nums/can_see_cost)
//      → ③ SQL 白名单 → ④/⑤ 引擎路由（明细→DuckDB 权限视图；汇总→PostgREST execute_sql_rls 走 RLS）
//      → ⑥ 审计(agent_query_logs)
// CommonJS（InsForge edge function runtime 要求），Deno 运行时，全局 fetch 可用。
// 共享打包（P3 铺开）：b64url/signJwt 与 CORS/json 提取到 ../_shared（jwt.ts / cors.ts）。
// 源码直接 require 共享模块，部署/校验时由 esbuild --bundle --format=cjs 打进单文件
// （scripts/deploy-functions.sh 用 .bundle 产物或本目录 index.bundle.js 部署；InsForge 运行时模型不变）。
const { signJwt } = require("../_shared/jwt");
const { json: sharedJson } = require("../_shared/cors");

// ===== 配置 =====
const AGENT_API_KEY = Deno.env.get("AGENT_API_KEY");
// 签名密钥：优先专用 JWT_SIGNING_KEY（JWT_SECRET 老 function secret 历史加密损坏，注入空串）；
// 回退到容器 env JWT_SECRET（compose 注入，恒在，值同 .env 的 JWT_SECRET）。
const JWT_SECRET = Deno.env.get("JWT_SIGNING_KEY") || Deno.env.get("JWT_SECRET") || "";
const DUCKDB_URL = Deno.env.get("DUCKDB_URL") || "http://duckdb:9000";
const POSTGREST_URL = Deno.env.get("POSTGREST_BASE_URL") || "http://postgrest:3000";

// 注册表读失败时的回退值（保证不线下；正常走数据注册中心 datasets/dataset_columns）
const RETAIL_GLOB_FALLBACK = "s3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet";
const COST_COLUMNS_FALLBACK = ["item_cost_price", "order_detail_cost", "order_detail_grade_cost", "cost", "profit", "sale_profit_rate"];
const REPORT_TABLES_FALLBACK = ["report_daily_sales", "report_daily_category", "report_weekly_trend"];
const MAX_ROWS = 1000;
const SHORT_JWT_TTL = 300; // 网关代签短时 JWT 有效期（秒）

// 数据注册中心读取：替代上面三处硬编码（glob/成本列/PG路由表）。
// 60s 缓存避免每查打 PG；读失败用回退值兜底，绝不线下。serviceJwt 在下方声明（函数提升，运行时调用）。
let REG_CACHE = null;
let REG_CACHE_TS = 0;
const REG_TTL_MS = 60000;
async function loadRegistry() {
  const now = Date.now();
  if (REG_CACHE && now - REG_CACHE_TS < REG_TTL_MS) return REG_CACHE;
  const headers = { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" };
  let retailGlob = RETAIL_GLOB_FALLBACK;
  let costColumns = COST_COLUMNS_FALLBACK.slice();
  let pgTables = REPORT_TABLES_FALLBACK.slice();
  let dimCarry = [];
  try {
    const dsRes = await fetch(POSTGREST_URL + "/datasets?select=name,engine,source,kind,carry_enabled,exposed", { headers });
    if (dsRes.ok) {
      const ds = await dsRes.json();
      const retailRow = ds.find((d) => d.name === "retail_detail");
      if (retailRow && retailRow.source) retailGlob = retailRow.source;
      const pg = ds.filter((d) => d.exposed && d.engine === "pg_table").map((d) => d.name);
      if (pg.length) pgTables = pg;
      // C3: carry 维表（duckdb_view + dim + carry_enabled），取每个维表的敏感列（per-user 脱敏用）
      const dimRows = ds.filter((d) => d.engine === "duckdb_view" && d.kind === "dim" && d.carry_enabled);
      for (const d of dimRows) {
        let sensitiveColumns = [];
        try {
          const scRes = await fetch(POSTGREST_URL + "/dataset_columns?select=name&dataset_name=eq." + encodeURIComponent(d.name) + "&is_sensitive=eq.true", { headers });
          if (scRes.ok) sensitiveColumns = (await scRes.json()).map((c) => c.name);
        } catch (e2) { /* 维表敏感列读失败空数组，不阻断 */ }
        dimCarry.push({ name: d.name, glob: d.source, sensitiveColumns });
      }
    }
    const colRes = await fetch(POSTGREST_URL + "/dataset_columns?select=name&dataset_name=eq.retail_detail&is_sensitive=eq.true", { headers });
    if (colRes.ok) {
      const cols = await colRes.json();
      if (Array.isArray(cols) && cols.length) costColumns = cols.map((c) => c.name);
    }
  } catch (e) {
    console.error("[agent-query] loadRegistry failed, using fallback:", String(e));
  }
  REG_CACHE = { retailGlob, costColumns, pgTables, dimCarry };
  REG_CACHE_TS = now;
  return REG_CACHE;
}

// 服务级短时 JWT（role=authenticated）：网关直连 PostgREST 用。
// PostgREST 不认 InsForge 的 anon_key（非 JWT），用 JWT_SECRET 自签的 JWT 它才认。
async function serviceJwt() {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: "agent-query", role: "authenticated", iss: "agent-query", iat: now, exp: now + 60 }, JWT_SECRET);
}

// ===== 工具 =====
// CORS 契约与 _shared 默认不同（methods 仅 POST/OPTIONS；Allow-Headers 多 x-agent-key）：
// 用 _shared 的 json + 本地覆盖这两键，响应头逐字节不变（只换来源，不改行为）。
const AGENT_CORS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-agent-key",
};
function json(data, status) {
  return sharedJson(data, status, AGENT_CORS);
}
function sqlLit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"; // branch_num 等数值字符串
}
const isPgQuery = (sql, pgTables) => pgTables.some((t) => new RegExp("\\b" + t + "\\b", "i").test(sql));

// SQL 白名单：仅 SELECT、禁 read_parquet/DDL/DML/COPY；无 LIMIT 则强制补
function validateSql(raw) {
  const trimmed = raw.trim().replace(/;+\s*$/, "");
  const u = trimmed.toUpperCase();
  if (!/^SELECT[\s(]/.test(u)) throw new Error("only_select_allowed");
  const forbidden = [
    "READ_PARQUET", "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE",
    "ALTER", "CREATE", "GRANT", "REVOKE", "COPY", "ATTACH", "PRAGMA",
  ];
  for (const kw of forbidden) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("forbidden_statement:" + kw);
  }
  if (/\bLIMIT\b/i.test(trimmed)) return trimmed;
  return trimmed + " LIMIT " + MAX_ROWS;
}

// ④ DuckDB 路径：拼权限视图（行 branch_nums 过滤 + 列成本组脱敏；成本列/glob 来源 reg=注册表）
async function runDuckdb(userSelect, perms, reg) {
  const allBranches = !Array.isArray(perms.branch_nums) || perms.branch_nums.length === 0 || perms.branch_nums.includes("*");
  const branchFilter = allBranches
    ? ""
    : "WHERE branch_num IN (" + perms.branch_nums.map(sqlLit).join(", ") + ")";
  const canSee = perms.can_see_cost ? "TRUE" : "FALSE";
  const replaceList = reg.costColumns.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  let viewSql =
    "CREATE OR REPLACE TEMP VIEW retail_detail AS " +
    "SELECT * REPLACE (" + replaceList + ") " +
    "FROM read_parquet('" + reg.retailGlob + "') " + branchFilter + ";";
  // C3: dim_* carry 视图（字典全可见；敏感列如 dim_item.item_cost_price 按 can_see_cost 脱敏，与 retail_detail 同机制）
  for (const d of (reg.dimCarry || [])) {
    const sens = d.sensitiveColumns || [];
    const dimReplace = sens.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
    const replaceClause = dimReplace ? `SELECT * REPLACE (${dimReplace}) ` : "SELECT * ";
    viewSql += "\nCREATE OR REPLACE TEMP VIEW " + d.name + " AS " + replaceClause + "FROM read_parquet('" + d.glob + "');";
  }
  // 一次提交：建视图 + 用户 SELECT（同连接，临时视图隔离，已实测）
  const combined = viewSql + "\n" + userSelect;
  const res = await fetch(DUCKDB_URL + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
    body: JSON.stringify({ sql: combined, user_id: perms.user_id }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error("duckdb:" + (body.error || res.status));
  return body.data;
}

// ⑤ PG 路径：代签短时 JWT（注入 branch_nums/can_see_cost）→ execute_sql_rls（SECURITY INVOKER，走 RLS）
async function runPg(userSelect, userId, perms) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: userId,
      role: "authenticated",
      branch_nums: perms.branch_nums,
      can_see_cost: !!perms.can_see_cost,
      iss: "agent-query",
      iat: now,
      exp: now + SHORT_JWT_TTL,
    },
    JWT_SECRET,
  );
  const res = await fetch(POSTGREST_URL + "/rpc/execute_sql_rls", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_query: userSelect }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("pg:" + (JSON.stringify(body.message || body) || res.status));
  // execute_sql_rls 拒绝时返回 [{error:...}]
  if (Array.isArray(body) && body.length === 1 && body[0] && body[0].error) {
    throw new Error("pg_rejected:" + body[0].error);
  }
  return body;
}

// ⑥ 审计
async function audit({ userId, userName, sql, finalSql, engine, rows, ms, err }) {
  try {
    await fetch(POSTGREST_URL + "/agent_query_logs", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        user_name: userName || null,
        query_text: sql,
        generated_sql: sql,
        final_sql: finalSql,
        data_source: engine,
        rows_returned: err ? 0 : rows || 0,
        execution_time_ms: ms,
      }),
    });
  } catch { /* 审计失败不影响主流程 */ }
}

// ===== 入口 =====
module.exports = async function (req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }
  const t0 = Date.now();
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  let userId = body.userId;
  const sql = body.sql;
  const key = body.agent_api_key || req.headers.get("x-agent-key");

  // ① 认证（前移到 cronSessionKey 反查前，#6：避免未认证请求驱动 serviceJwt RPC 轻量 DoS）
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) return json({ error: "unauthorized" }, 401);

  // C4: cron turn 无 userId（requesterSenderId 空）→ 从 cronSessionKey 反查 scheduled_reports.run_as
  // cron turn ctx.sessionKey = agent:<agentId>:cron:<jobid>:run:<runId>（openclaw 源码确认）
  if (!userId && body.cronSessionKey) {
    const m = body.cronSessionKey.match(/cron:([^:]+)/i);
    if (m) {
      try {
        const rr = await fetch(POSTGREST_URL + "/rpc/get_scheduled_run_as", {
          method: "POST",
          headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
          body: JSON.stringify({ p_cron_job_id: m[1] }),
        });
        const runAs = await rr.json();
        if (typeof runAs === "string" && runAs) userId = runAs;
      } catch (e) { /* 反查失败，userId 仍空，下面报 missing */ }
    }
  }

  // ①.5 dictionary 模式（LLM list_datasets 工具拉字典；只需认证，不需 per-user 权限）
  if (body.mode === "dictionary") {
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/get_data_dictionary", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
        body: "{}",
      });
      const dictionary = await r.json();
      return json({ success: true, dictionary });
    } catch (e) {
      return json({ error: "dictionary_failed", detail: String(e) }, 502);
    }
  }

  // C4: 定时应用管理 mode（plugin create_scheduled_report/push_report 调；SECURITY DEFINER RPC）
  if (body.mode === "upsert_scheduled") {
    if (!userId) return json({ error: "missing userId (owner) for upsert_scheduled" }, 400);
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/insert_scheduled_report", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
        body: JSON.stringify({ p_owner: userId, p_cron_job_id: body.cron_job_id, p_name: body.name, p_mode: body.sr_mode, p_template_key: body.template_key || null, p_query_intent: body.query_intent || null }),
      });
      const id = await r.json();
      return json({ success: true, id });
    } catch (e) { return json({ error: "upsert_failed", detail: String(e) }, 502); }
  }
  if (body.mode === "lookup_delivery") {
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/get_scheduled_delivery_to", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
        body: JSON.stringify({ p_cron_job_id: body.cron_job_id }),
      });
      const to = await r.json();
      return json({ success: true, delivery_to: to });
    } catch (e) { return json({ error: "lookup_failed", detail: String(e) }, 502); }
  }
  if (body.mode === "delete_scheduled") {
    if (!userId) return json({ error: "missing userId (owner) for delete_scheduled" }, 400);
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/delete_scheduled_report", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
        body: JSON.stringify({ p_owner: userId, p_cron_job_id: body.cron_job_id }),
      });
      const result = await r.json();
      return json({ success: true, result });
    } catch (e) { return json({ error: "delete_failed", detail: String(e) }, 502); }
  }

  if (!sql || !userId) return json({ error: "missing sql/userId" }, 400);

  // ② 授权
  let perms;
  try {
    const pr = await fetch(POSTGREST_URL + "/rpc/get_user_perms", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
      body: JSON.stringify({ p_wecom_id: userId }),
    });
    perms = await pr.json();
  } catch (e) {
    return json({ error: "perm_resolve_failed", detail: String(e) }, 502);
  }
  if (!perms || perms.error || !Array.isArray(perms.branch_nums)) {
    return json({ error: "no_permission", detail: perms && perms.error }, 403);
  }

  // ③ SQL 白名单
  let finalSql;
  try {
    finalSql = validateSql(sql);
  } catch (e) {
    return json({ error: "sql_rejected", rule: e.message }, 400);
  }

  // ④/⑤ 引擎路由（pg_table 数据集→PG，否则→DuckDB；来源注册表）
  const reg = await loadRegistry();
  const engine = isPgQuery(sql, reg.pgTables) ? "pg" : "duckdb";
  let data, err;
  try {
    data = engine === "pg" ? await runPg(finalSql, userId, perms) : await runDuckdb(finalSql, perms, reg);
  } catch (e) {
    err = String(e.message || e);
  }

  // ⑥ 审计
  await audit({
    userId, userName: perms.user_name, sql, finalSql, engine,
    rows: data && data.length, ms: Date.now() - t0, err,
  });

  if (err) return json({ error: err }, 500);
  return json({ success: true, engine, perms: { branch_nums: perms.branch_nums, can_see_cost: perms.can_see_cost }, rowCount: data.length, data });
};
