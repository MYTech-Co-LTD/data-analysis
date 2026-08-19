var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// functions/_shared/jwt.ts
var require_jwt = __commonJS({
  "functions/_shared/jwt.ts"(exports2, module2) {
    function b64url(bytes) {
      let s = "";
      for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    async function signJwt2(payload, secret) {
      const enc = new TextEncoder();
      const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
      const p = b64url(enc.encode(JSON.stringify(payload)));
      const data = `${h}.${p}`;
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
      return `${data}.${b64url(sig)}`;
    }
    module2.exports = { b64url, signJwt: signJwt2 };
  }
});

// functions/_shared/cors.ts
var require_cors = __commonJS({
  "functions/_shared/cors.ts"(exports2, module2) {
    var corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    function json2(data, status, extraHeaders) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders || {} }
      });
    }
    module2.exports = { corsHeaders, json: json2 };
  }
});

// functions/agent-query/index.js
var { signJwt } = require_jwt();
var { json: sharedJson } = require_cors();
var AGENT_API_KEY = Deno.env.get("AGENT_API_KEY");
var JWT_SECRET = Deno.env.get("JWT_SIGNING_KEY") || Deno.env.get("JWT_SECRET") || "";
var DUCKDB_URL = Deno.env.get("DUCKDB_URL") || "http://duckdb:9000";
var POSTGREST_URL = Deno.env.get("POSTGREST_BASE_URL") || "http://postgrest:3000";
var RETAIL_GLOB_FALLBACK = "s3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet";
var COST_COLUMNS_FALLBACK = ["item_cost_price", "order_detail_cost", "order_detail_grade_cost", "cost", "profit", "sale_profit_rate"];
var REPORT_TABLES_FALLBACK = ["report_daily_sales", "report_daily_category", "report_weekly_trend"];
var MAX_ROWS = 1e3;
var SHORT_JWT_TTL = 300;
var REG_CACHE = null;
var REG_CACHE_TS = 0;
var REG_TTL_MS = 6e4;
async function loadRegistry() {
  const now = Date.now();
  if (REG_CACHE && now - REG_CACHE_TS < REG_TTL_MS) return REG_CACHE;
  const headers = { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" };
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
      const dimRows = ds.filter((d) => d.engine === "duckdb_view" && d.kind === "dim" && d.carry_enabled);
      for (const d of dimRows) {
        let sensitiveColumns = [];
        try {
          const scRes = await fetch(POSTGREST_URL + "/dataset_columns?select=name&dataset_name=eq." + encodeURIComponent(d.name) + "&is_sensitive=eq.true", { headers });
          if (scRes.ok) sensitiveColumns = (await scRes.json()).map((c) => c.name);
        } catch (e2) {
        }
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
async function serviceJwt() {
  const now = Math.floor(Date.now() / 1e3);
  return signJwt({ sub: "agent-query", role: "authenticated", iss: "agent-query", iat: now, exp: now + 60 }, JWT_SECRET);
}
var AGENT_CORS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-agent-key"
};
function json(data, status) {
  return sharedJson(data, status, AGENT_CORS);
}
function sqlLit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
var isPgQuery = (sql, pgTables) => pgTables.some((t) => new RegExp("\\b" + t + "\\b", "i").test(sql));
function validateSql(raw) {
  const trimmed = raw.trim().replace(/;+\s*$/, "");
  const u = trimmed.toUpperCase();
  if (!/^SELECT[\s(]/.test(u)) throw new Error("only_select_allowed");
  const forbidden = [
    "READ_PARQUET",
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "TRUNCATE",
    "ALTER",
    "CREATE",
    "GRANT",
    "REVOKE",
    "COPY",
    "ATTACH",
    "PRAGMA"
  ];
  for (const kw of forbidden) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("forbidden_statement:" + kw);
  }
  if (/\bLIMIT\b/i.test(trimmed)) return trimmed;
  return trimmed + " LIMIT " + MAX_ROWS;
}
var normKey = (s) => String(s).replace(/^([0-9]+)-0+([0-9]+)$/, "$1-$2");
async function runDuckdb(userSelect, perms, reg) {
  const branchNums = perms.data_scope?.branch_nums ?? [];
  const allBranches = !Array.isArray(branchNums) || branchNums.includes("*");
  const authKeys = [...new Set(branchNums.filter((v) => String(v).includes("-")).map(normKey))];
  const branchFilter = allBranches ? "" : authKeys.length === 0 ? "WHERE 1=0" : "WHERE (regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) || '-' || branch_num) IN (" + authKeys.map(sqlLit).join(", ") + ")";
  const canSee = perms.fields?.cost ? "TRUE" : "FALSE";
  const replaceList = reg.costColumns.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  let viewSql = "CREATE OR REPLACE TEMP VIEW retail_detail AS SELECT * REPLACE (" + replaceList + ") FROM read_parquet('" + reg.retailGlob + "', filename=true, union_by_name=true) " + branchFilter + ";";
  for (const d of reg.dimCarry || []) {
    const sens = d.sensitiveColumns || [];
    const dimReplace = sens.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
    const replaceClause = dimReplace ? `SELECT * REPLACE (${dimReplace}) ` : "SELECT * ";
    viewSql += "\nCREATE OR REPLACE TEMP VIEW " + d.name + " AS " + replaceClause + "FROM read_parquet('" + d.glob + "');";
  }
  const combined = viewSql + "\n" + userSelect;
  const res = await fetch(DUCKDB_URL + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
    body: JSON.stringify({ sql: combined, user_id: perms.user_id })
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error("duckdb:" + (body.error || res.status));
  return body.data;
}
async function runPg(userSelect, userId, perms) {
  const now = Math.floor(Date.now() / 1e3);
  const token = await signJwt(
    {
      sub: userId,
      role: "authenticated",
      data_scope: {
        branch_nums: perms.data_scope?.branch_nums ?? [],
        brands: perms.data_scope?.brands || [],
        categories: perms.data_scope?.categories || []
      },
      fields: { cost: !!perms.fields?.cost },
      can_see_cost: !!perms.fields?.cost,
      iss: "agent-query",
      iat: now,
      exp: now + SHORT_JWT_TTL
    },
    JWT_SECRET
  );
  const res = await fetch(POSTGREST_URL + "/rpc/execute_sql_rls", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_query: userSelect })
  });
  const body = await res.json();
  if (!res.ok) throw new Error("pg:" + (JSON.stringify(body.message || body) || res.status));
  if (Array.isArray(body) && body.length === 1 && body[0] && body[0].error) {
    throw new Error("pg_rejected:" + body[0].error);
  }
  return body;
}
async function audit({ userId, userName, sql, finalSql, engine, rows, ms, err }) {
  try {
    await fetch(POSTGREST_URL + "/agent_query_logs", {
      method: "POST",
      headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        user_name: userName || null,
        query_text: sql,
        generated_sql: sql,
        final_sql: finalSql,
        data_source: engine,
        rows_returned: err ? 0 : rows || 0,
        execution_time_ms: ms
      })
    });
  } catch {
  }
}
module.exports = async function(req) {
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
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) return json({ error: "unauthorized" }, 401);
  if (!userId && body.cronSessionKey) {
    const m = body.cronSessionKey.match(/cron:([^:]+)/i);
    if (m) {
      try {
        const rr = await fetch(POSTGREST_URL + "/rpc/get_scheduled_run_as", {
          method: "POST",
          headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
          body: JSON.stringify({ p_cron_job_id: m[1] })
        });
        const runAs = await rr.json();
        if (typeof runAs === "string" && runAs) userId = runAs;
      } catch (e) {
      }
    }
  }
  if (body.mode === "dictionary") {
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/get_data_dictionary", {
        method: "POST",
        headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
        body: "{}"
      });
      const dictionary = await r.json();
      return json({ success: true, dictionary });
    } catch (e) {
      return json({ error: "dictionary_failed", detail: String(e) }, 502);
    }
  }
  if (body.mode === "upsert_scheduled") {
    if (!userId) return json({ error: "missing userId (owner) for upsert_scheduled" }, 400);
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/insert_scheduled_report", {
        method: "POST",
        headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
        body: JSON.stringify({ p_owner: userId, p_cron_job_id: body.cron_job_id, p_name: body.name, p_mode: body.sr_mode, p_template_key: body.template_key || null, p_query_intent: body.query_intent || null })
      });
      const id = await r.json();
      return json({ success: true, id });
    } catch (e) {
      return json({ error: "upsert_failed", detail: String(e) }, 502);
    }
  }
  if (body.mode === "lookup_delivery") {
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/get_scheduled_delivery_to", {
        method: "POST",
        headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
        body: JSON.stringify({ p_cron_job_id: body.cron_job_id })
      });
      const to = await r.json();
      return json({ success: true, delivery_to: to });
    } catch (e) {
      return json({ error: "lookup_failed", detail: String(e) }, 502);
    }
  }
  if (body.mode === "delete_scheduled") {
    if (!userId) return json({ error: "missing userId (owner) for delete_scheduled" }, 400);
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/delete_scheduled_report", {
        method: "POST",
        headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
        body: JSON.stringify({ p_owner: userId, p_cron_job_id: body.cron_job_id })
      });
      const result = await r.json();
      return json({ success: true, result });
    } catch (e) {
      return json({ error: "delete_failed", detail: String(e) }, 502);
    }
  }
  if (body.mode === "push_report") {
    try {
      const webBase = Deno.env.get("WEB_BASE_URL") || "http://web:3000";
      const rawSel = body.selector || { type: "all" };
      const selKind = rawSel && typeof rawSel === "object" && rawSel.kind ? rawSel.kind : rawSel && typeof rawSel === "object" && rawSel.type === "all" ? "all" : "all";
      const pushResp = await fetch(webBase + "/api/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (AGENT_API_KEY || "")
        },
        body: JSON.stringify({
          workflowId: body.workflow_id || "scheduled_report",
          userId: userId || "system:cron",
          selector: { kind: selKind, ids: rawSel && Array.isArray(rawSel.ids) ? rawSel.ids : [] },
          broadcastPerm: !!(body.broadcast_perm || body.broadcastPerm),
          deliver: body.deliver !== false
        })
      });
      const pushResult = await pushResp.json().catch(() => ({}));
      if (!pushResp.ok) {
        return json({ error: "push_failed", detail: pushResult }, pushResp.status || 502);
      }
      return json({ success: true, ...pushResult });
    } catch (e) {
      return json({ error: "push_failed", detail: String(e) }, 502);
    }
  }
  if (!sql || !userId) return json({ error: "missing sql/userId" }, 400);
  let perms;
  try {
    const pr = await fetch(POSTGREST_URL + "/rpc/get_user_perms", {
      method: "POST",
      headers: { Authorization: "Bearer " + await serviceJwt(), "Content-Type": "application/json" },
      body: JSON.stringify({ p_wecom_id: userId })
    });
    perms = await pr.json();
  } catch (e) {
    return json({ error: "perm_resolve_failed", detail: String(e) }, 502);
  }
  const branchNums = perms.data_scope?.branch_nums ?? perms.branch_nums;
  if (!perms || perms.error || !Array.isArray(branchNums)) {
    return json({ error: "no_permission", detail: perms && perms.error }, 403);
  }
  let finalSql;
  try {
    finalSql = validateSql(sql);
  } catch (e) {
    return json({ error: "sql_rejected", rule: e.message }, 400);
  }
  const reg = await loadRegistry();
  const engine = isPgQuery(sql, reg.pgTables) ? "pg" : "duckdb";
  let data, err;
  try {
    data = engine === "pg" ? await runPg(finalSql, userId, perms) : await runDuckdb(finalSql, perms, reg);
  } catch (e) {
    err = String(e.message || e);
  }
  await audit({
    userId,
    userName: perms.user_name,
    sql,
    finalSql,
    engine,
    rows: data && data.length,
    ms: Date.now() - t0,
    err
  });
  if (err) return json({ error: err }, 500);
  return json({ success: true, engine, perms: { branch_nums: perms.branch_nums, can_see_cost: perms.can_see_cost }, rowCount: data.length, data });
};
