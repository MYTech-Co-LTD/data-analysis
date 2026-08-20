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

// ===== 服务身份 JWT 验签（U1b 收敛：openclaw:query scope，替代共享密钥冒充面）=====
// Casdoor client_credentials 签发的 RS256 JWT（sub=openclaw-gateway）。
// 与 web/lib/token-verify.ts 同语义：JWKS 缓存 ≥24h + kid 不命中主动刷新；
// iss + aud(CASDOOR_CLIENT_ID) + exp + scope 含 needScope；一切失败 fail-close 返回 null。
// 零依赖：Deno 全局 crypto.subtle（RSASSA-PKCS1-v1_5 / SHA-256）+ fetch + atob。
const JWKS_URL = Deno.env.get("CASDOOR_JWKS_URL") || "https://sso.shanhaiyiguo.com/.well-known/jwks";
const JWT_ISSUER = Deno.env.get("CASDOOR_ISSUER") || "https://sso.shanhaiyiguo.com";
const JWT_AUDIENCE = Deno.env.get("CASDOOR_CLIENT_ID") || ""; // 空串 = aud 无从校验 → fail-close
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
let JWKS_CACHE = null; // { keys: [{kid,kty,...}], fetchedAt }

function b64uToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function loadJwks(force) {
  const fresh = JWKS_CACHE && Date.now() - JWKS_CACHE.fetchedAt < JWKS_TTL_MS;
  if (!force && fresh) return JWKS_CACHE.keys;
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
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
      // kid 不命中（轮换后的新钥）→ 强制刷新一次
      keys = await loadJwks(true);
      jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return null;
    }

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const okSig = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
    if (!okSig) return null;

    const p = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    if (typeof p.exp !== "number" || p.exp <= now) return null;
    if (p.iss !== JWT_ISSUER) return null;
    const audOk = Array.isArray(p.aud) ? p.aud.includes(JWT_AUDIENCE) : p.aud === JWT_AUDIENCE;
    if (!audOk) return null;
    // scope：Casdoor 签发为空格分隔字符串；兼容数组
    const scopes = Array.isArray(p.scope)
      ? p.scope.map(String)
      : typeof p.scope === "string" ? p.scope.split(/[\s,]+/).filter(Boolean) : [];
    if (!scopes.includes(needScope)) return null;
    if (typeof p.sub !== "string" || !p.sub) return null;
    return { sub: p.sub }; // sub=openclaw-gateway（服务身份）；数据主体仍由 userId 决定
  } catch {
    return null; // 一切异常 fail-close
  }
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
// ★表引用正向白名单（防 LLM「自己发挥」直接读原文件）：DuckDB 允许
//   FROM 's3://...'（字符串表，零关键词）、parquet_scan/read_csv/read_json 等同义/邻接函数，
//   黑名单挡不住 → 改为：FROM/JOIN 目标只许 allowedTables（本次请求的权限视图 + PG 路由表
//   + SQL 自身 WITH 定义的 CTE）；FROM 后跟字符串字面量/表函数调用一律拒绝。
const FORBIDDEN_KEYWORDS = [
  "READ_PARQUET", "PARQUET_SCAN", "READ_CSV", "READ_JSON", "READ_TEXT", "READ_BLOB",
  "GLOB", "ST_READ", "POSTGRES_SCAN", "POSTGRES_ATTACH", "SCAN_",
  "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE",
  "ALTER", "CREATE", "GRANT", "REVOKE", "COPY", "ATTACH", "PRAGMA",
  "SET", "CALL", "INSTALL", "LOAD", "EXPORT", "IMPORT", "SECRET",
];
// FROM/JOIN 后的引用提取（带可选引号包裹的标识符）
const FROM_JOIN_REF_RE = /\b(?:from|join)\s+([`"\[]?)([A-Za-z_][A-Za-z0-9_]*)\1/gi;
function validateSql(raw, allowedTables) {
  const trimmed = raw.trim().replace(/;+\s*$/, "");
  const u = trimmed.toUpperCase();
  if (!/^SELECT[\s(]/.test(u) && !/^WITH[\s(]/.test(u)) throw new Error("only_select_allowed");
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("forbidden_statement:" + kw);
  }
  // ① 字符串表/文件路径/URL：FROM 后直接跟引号串，或任何含 :// 、.parquet/.csv/.json 的字面量
  if (/\b(?:from|join)\s*'/i.test(trimmed)) throw new Error("forbidden_string_table");
  if (/'[^']*:\/\//i.test(trimmed) || /'[^']*\.(parquet|csv|json|tsv|jsonl)/i.test(trimmed)) {
    throw new Error("forbidden_file_reference");
  }
  // ② 表函数调用：FROM x( → x 必是函数（parquet_scan 等在 FROM 位置的变体）
  if (/\b(?:from|join)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/i.test(trimmed)) {
    throw new Error("forbidden_table_function");
  }
  // ③ CTE 名（WITH x AS / , x AS）视为合法引用目标
  const ctes = new Set();
  const withRe = /\b(?:with|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi;
  let wm;
  while ((wm = withRe.exec(trimmed)) !== null) ctes.add(wm[1].toLowerCase());
  // ④ 正向白名单：每个 FROM/JOIN 标识符 ∈ 权限视图 ∪ PG 路由表 ∪ CTE
  const allowed = new Set([...allowedTables, ...ctes].map((t) => String(t).toLowerCase()));
  let m;
  FROM_JOIN_REF_RE.lastIndex = 0;
  while ((m = FROM_JOIN_REF_RE.exec(trimmed)) !== null) {
    if (!allowed.has(m[2].toLowerCase())) throw new Error("forbidden_table:" + m[2]);
  }
  if (/\bLIMIT\b/i.test(trimmed)) return trimmed;
  return trimmed + " LIMIT " + MAX_ROWS;
}

// 复合键归一（186 同款）：'3120-0027' → '3120-27'（尾段去前导零，双侧对称）
const normKey = (s) => String(s).replace(/^([0-9]+)-0+([0-9]+)$/, "$1-$2");

// ④ DuckDB 路径：拼权限视图（行 branch_nums 过滤 + 列成本组脱敏；成本列/glob 来源 reg=注册表）
// B1（185 casdoor-only 语义）：branch_nums=[] = authorized ∅ = deny——旧「无 perms=全放」宽松形状
// 已随 data_permissions sunset 废弃；仅 ["*"]（服务身份宽松形状 / 全店授权）= 不加门店过滤。
// ★门店键铁律 + 键形态（PR#15 家族）：parquet branch_num 是裸编号且无 sbc 列，sbc 只在
// 文件路径（QA/c1 同款 regexp_extract(filename) 提取）；claims 授权是规范复合键——比较前
// 双侧归一（186 同款尾段去前导零）。裸授权值（无 '-'）跨账套不唯一不参与匹配（deny 方向）。
async function runDuckdb(userSelect, perms, reg) {
  // T7/M4：消费 data_scope/fields 新形状（get_user_perms 双形同源同值，M6 摘旧 key 前置）
  const branchNums = perms.data_scope?.branch_nums ?? [];
  const allBranches = !Array.isArray(branchNums) || branchNums.includes("*");
  const authKeys = [...new Set(branchNums.filter((v) => String(v).includes("-")).map(normKey))];
  const branchFilter = allBranches
    ? ""
    : authKeys.length === 0
      ? "WHERE 1=0"
      : "WHERE (regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) || '-' || branch_num) IN (" + authKeys.map(sqlLit).join(", ") + ")";
  const canSee = perms.fields?.cost ? "TRUE" : "FALSE";
  const replaceList = reg.costColumns.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  let viewSql =
    "CREATE OR REPLACE TEMP VIEW retail_detail AS " +
    "SELECT * REPLACE (" + replaceList + ") " +
    "FROM read_parquet('" + reg.retailGlob + "', filename=true, union_by_name=true) " + branchFilter + ";";
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

// ⑤ PG 路径：代签短时 JWT（185 终版 RLS 只认 data_scope 新形状——旧形状令牌=deny，S4 窗口已关）
//    → execute_sql_rls（SECURITY INVOKER，走 RLS）。brands/categories 无 DB 镜像（185：deny 方向，
//    权威源=登录 claims）；服务身份（未知用户）get_user_perms 宽松形状 ["*"] 全维放行。
async function runPg(userSelect, userId, perms) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: userId,
      role: "authenticated",
      data_scope: {
        branch_nums: perms.data_scope?.branch_nums ?? [],
        brands: perms.data_scope?.brands || [],
        categories: perms.data_scope?.categories || [],
      },
      fields: { cost: !!perms.fields?.cost },
      can_see_cost: !!perms.fields?.cost,
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

  // ① 认证双通道（U1b）：Authorization Bearer Casdoor 服务 JWT（scope openclaw:query）优先；
  // 未带 Bearer → 过渡期 AGENT_API_KEY 共享密钥兜底（与 /api/push 同款双通道，下线计划见 runbook）。
  // 带 Bearer 但验签失败 = 显式拒绝（不得回落共享密钥，防降级攻击）。
  const bearer = (req.headers.get("authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const svc = await verifyServiceJwt(bearer.slice(7).trim(), "openclaw:query");
    if (!svc) return json({ error: "unauthorized" }, 401);
  } else if (!AGENT_API_KEY || key !== AGENT_API_KEY) {
    return json({ error: "unauthorized" }, 401);
  }

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

  // U7 cutover: push_report 路径切 run_push 引擎。
  // 旧路径：wecom-push function 直接读 reports 表 + 发企微 textcard（已退役，代码保留）。
  // 新路径：调 web /api/push API → run_push 引擎（四守卫+Novu+bridge+降级）。
  // txnId 贯穿 trigger log → Novu → bridge 日志，全链路可追。
  // rollback：重启用 wecom-push cron 即可回退旧路径。
  if (body.mode === "push_report") {
    try {
      const webBase = Deno.env.get("WEB_BASE_URL") || "http://web:3000";
      // Review 修复（B3）：body 字段对齐 /api/push 契约（camelCase workflowId/userId/selector.kind），
      // 鉴权走 AGENT_API_KEY（route 已支持内部调用方双通道）。
      const rawSel = body.selector || { type: "all" };
      const selKind = (rawSel && typeof rawSel === "object" && rawSel.kind)
        ? rawSel.kind
        : (rawSel && typeof rawSel === "object" && rawSel.type === "all" ? "all" : "all");
      const pushResp = await fetch(webBase + "/api/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (AGENT_API_KEY || ""),
        },
        body: JSON.stringify({
          workflowId: body.workflow_id || "scheduled_report",
          userId: userId || "system:cron",
          selector: { kind: selKind, ids: (rawSel && Array.isArray(rawSel.ids)) ? rawSel.ids : [] },
          broadcastPerm: !!(body.broadcast_perm || body.broadcastPerm),
          deliver: body.deliver !== false,
        }),
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
  // 异种 review #11：双形 fallback——旧形状（无 data_scope 段）也接受顶层 branch_nums，防 function-only
  // 部署在迁移 200 前单独上线时全员 403（部署纪律窗口，runbook 标注）。
  const branchNums = perms.data_scope?.branch_nums ?? perms.branch_nums;
  if (!perms || perms.error || !Array.isArray(branchNums)) {
    return json({ error: "no_permission", detail: perms && perms.error }, 403);
  }

  // ③ SQL 白名单（表引用正向白名单：引擎路由前先给全量合法表集——DuckDB 权限视图
  // + carry 维表视图 + PG 路由表，均为权限强制面；CTE 由 validateSql 自行识别）
  const regPre = await loadRegistry();
  const allowedTables = ["retail_detail", ...regPre.pgTables, ...(regPre.dimCarry || []).map((d) => d.name)];
  let finalSql;
  try {
    finalSql = validateSql(sql, allowedTables);
  } catch (e) {
    return json({ error: "sql_rejected", rule: e.message }, 400);
  }

  // ④/⑤ 引擎路由（pg_table 数据集→PG，否则→DuckDB；来源注册表）
  const reg = regPre;
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
