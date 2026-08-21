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
var JWKS_URL = Deno.env.get("CASDOOR_JWKS_URL") || "https://sso.shanhaiyiguo.com/.well-known/jwks";
var JWT_ISSUER = Deno.env.get("CASDOOR_ISSUER") || "https://sso.shanhaiyiguo.com";
var JWT_AUDIENCE = Deno.env.get("CASDOOR_CLIENT_ID") || "";
var JWKS_TTL_MS = 24 * 60 * 60 * 1e3;
var JWKS_CACHE = null;
function b64uToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function loadJwks(force) {
  const fresh = JWKS_CACHE && Date.now() - JWKS_CACHE.fetchedAt < JWKS_TTL_MS;
  if (!force && fresh) return JWKS_CACHE.keys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5e3) });
  if (!res.ok) throw new Error("jwks http " + res.status);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("jwks bad payload");
  JWKS_CACHE = { keys: body.keys, fetchedAt: Date.now() };
  return JWKS_CACHE.keys;
}
async function verifyServiceJwt(token, needScope) {
  try {
    if (!token || !needScope || !JWT_AUDIENCE) return null;
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
    if (header.alg !== "RS256" || !header.kid) return null;
    let keys = await loadJwks(false).catch(() => null);
    let jwk = keys && keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await loadJwks(true);
      jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return null;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const okSig = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64uToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (!okSig) return null;
    const p = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
    const now = Math.floor(Date.now() / 1e3);
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (p.iss !== JWT_ISSUER) return null;
    const audOk = Array.isArray(p.aud) ? p.aud.includes(JWT_AUDIENCE) : p.aud === JWT_AUDIENCE;
    if (!audOk) return null;
    const scopes = Array.isArray(p.scope) ? p.scope.map(String) : typeof p.scope === "string" ? p.scope.split(/[\s,]+/).filter(Boolean) : [];
    if (!scopes.includes(needScope)) return null;
    if (typeof p.sub !== "string" || !p.sub) return null;
    return { sub: p.sub };
  } catch {
    return null;
  }
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
var FORBIDDEN_KEYWORDS = [
  "READ_PARQUET",
  "PARQUET_SCAN",
  "READ_CSV",
  "READ_JSON",
  "READ_TEXT",
  "READ_BLOB",
  "GLOB",
  "ST_READ",
  "POSTGRES_SCAN",
  "POSTGRES_ATTACH",
  "SCAN_",
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
  "PRAGMA",
  "SET",
  "CALL",
  "INSTALL",
  "LOAD",
  "EXPORT",
  "IMPORT",
  "SECRET"
];
var FROM_JOIN_REF_RE = /\b(?:from|join)\s+([`"\[]?)([A-Za-z_][A-Za-z0-9_]*)\1/gi;
function validateSql(raw, allowedTables) {
  const trimmed = raw.trim().replace(/;+\s*$/, "");
  const u = trimmed.toUpperCase();
  if (!/^SELECT[\s(]/.test(u) && !/^WITH[\s(]/.test(u)) throw new Error("only_select_allowed");
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("forbidden_statement:" + kw);
  }
  if (/\b(?:from|join)\s*'/i.test(trimmed)) throw new Error("forbidden_string_table");
  if (/'[^']*:\/\//i.test(trimmed) || /'[^']*\.(parquet|csv|json|tsv|jsonl)/i.test(trimmed)) {
    throw new Error("forbidden_file_reference");
  }
  if (/\b(?:from|join)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/i.test(trimmed)) {
    throw new Error("forbidden_table_function");
  }
  const ctes = /* @__PURE__ */ new Set();
  const withRe = /\b(?:with|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi;
  let wm;
  while ((wm = withRe.exec(trimmed)) !== null) ctes.add(wm[1].toLowerCase());
  const allowed = new Set([...allowedTables, ...ctes].map((t) => String(t).toLowerCase()));
  let m;
  FROM_JOIN_REF_RE.lastIndex = 0;
  while ((m = FROM_JOIN_REF_RE.exec(trimmed)) !== null) {
    if (!allowed.has(m[2].toLowerCase())) throw new Error("forbidden_table:" + m[2]);
  }
  if (/\bCROSS\s+JOIN\b/i.test(trimmed)) throw new Error("forbidden_cross_join");
  const aliasRe = "(?:\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?";
  const joinRe = new RegExp(
    "\\bJOIN\\s+[A-Za-z_][A-Za-z0-9_]*" + aliasRe + "\\s+ON\\b([\\s\\S]*?)(?=\\b(?:JOIN|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING|UNION)\\b|$)",
    "gi"
  );
  let jm;
  joinRe.lastIndex = 0;
  while ((jm = joinRe.exec(trimmed)) !== null) {
    const onClause = jm[1] || "";
    if (/\bbranch_num\b/i.test(onClause) && !/\bsystem_book_code\b/i.test(onClause)) {
      throw new Error("forbidden_branch_join");
    }
  }
  const usingRe = new RegExp(
    "\\bJOIN\\s+[A-Za-z_][A-Za-z0-9_]*" + aliasRe + "\\s+USING\\s*\\(([^)]*)\\)",
    "gi"
  );
  let um;
  usingRe.lastIndex = 0;
  while ((um = usingRe.exec(trimmed)) !== null) {
    if (/\bbranch_num\b/i.test(um[1]) && !/\bsystem_book_code\b/i.test(um[1])) {
      throw new Error("forbidden_branch_join");
    }
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
  let viewSql = "";
  for (const d of reg.dimCarry || []) {
    const sens = d.sensitiveColumns || [];
    const dimReplace = sens.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
    const replaceClause = dimReplace ? `SELECT * REPLACE (${dimReplace}) ` : "SELECT * ";
    viewSql += "\nCREATE OR REPLACE TEMP VIEW " + d.name + " AS " + replaceClause + "FROM read_parquet('" + d.glob + "');";
  }
  viewSql += "\nCREATE OR REPLACE TEMP VIEW retail_detail AS SELECT rd.*, db.region_name, db.first_level_region AS war_zone_name FROM (SELECT *, regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code FROM (SELECT * REPLACE (" + replaceList + ") FROM read_parquet('" + reg.retailGlob + "', filename=true, union_by_name=true) " + branchFilter + ") t) rd LEFT JOIN dim_branch db ON rd.system_book_code = db.system_book_code AND rd.branch_num = db.branch_num;";
  const outboundFilter = allBranches ? "" : authKeys.length === 0 ? "WHERE 1=0" : "WHERE regexp_replace(sbc || '-' || branch_num, '^([0-9]+)-0+([0-9]+)$', '\\1-\\2') IN (" + authKeys.map(sqlLit).join(", ") + ")";
  const outboundProfit = `CASE WHEN ${canSee} THEN t.profit ELSE NULL END AS profit`;
  viewSql += "\nCREATE OR REPLACE TEMP VIEW outbound_detail AS SELECT biz_type, sbc, branch_num, biz_date, amount, " + outboundProfit + ", item_name, category FROM (SELECT 'delivery' AS biz_type, regexp_extract(filename, 'transfer_detail/([0-9]+)/', 1) AS sbc, response_branch_num AS branch_num, substr(order_time,1,10) AS biz_date, CAST(out_money AS DOUBLE) AS amount, CAST(profit_money AS DOUBLE) AS profit, pos_item_name AS item_name, item_category AS category FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/*/*/all.parquet', filename=true) UNION ALL SELECT 'wholesale' AS biz_type, COALESCE(db.system_book_code, regexp_extract(d.filename, 'wholesale_detail/([0-9]+)/', 1)) AS sbc, COALESCE(db.branch_num, '99') AS branch_num, substr(d.audit_time,1,10) AS biz_date, CAST(d.wholesale_money AS DOUBLE) AS amount, CAST(d.wholesale_profit AS DOUBLE) AS profit, d.pos_item_name AS item_name, d.pos_item_category_name AS category FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet', filename=true) d LEFT JOIN dim_branch db ON db.system_book_code='64188' AND db.branch_name = d.client_name ) t " + outboundFilter + ";";
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
  const bearer = (req.headers.get("authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const svc = await verifyServiceJwt(bearer.slice(7).trim(), "openclaw:query");
    if (!svc) return json({ error: "unauthorized" }, 401);
  } else if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
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
  const regPre = await loadRegistry();
  const allowedTables = ["retail_detail", "outbound_detail", ...regPre.pgTables, ...(regPre.dimCarry || []).map((d) => d.name)];
  let finalSql;
  try {
    finalSql = validateSql(sql, allowedTables);
  } catch (e) {
    return json({ error: "sql_rejected", rule: e.message }, 400);
  }
  const reg = regPre;
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
