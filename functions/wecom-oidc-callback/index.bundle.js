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
    var corsHeaders2 = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    function json2(data, status, extraHeaders) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders2, "Content-Type": "application/json", ...extraHeaders || {} }
      });
    }
    module2.exports = { corsHeaders: corsHeaders2, json: json2 };
  }
});

// functions/wecom-oidc-callback/claims.js
var require_claims = __commonJS({
  "functions/wecom-oidc-callback/claims.js"(exports2, module2) {
    function buildClaims2(ctx) {
      const oidcGroups = ctx.oidcToken?.groups ?? null;
      if (!Array.isArray(oidcGroups) || oidcGroups.length === 0) return null;
      if (!Array.isArray(ctx.reachable)) return null;
      const expanded = ctx.expandResult;
      if (!expanded || expanded.ok !== true) return null;
      const normReach = ctx.reachable.map((k) => FRIENDLY_TO_KEY[k] ?? k);
      const permissions = [...new Set(normReach.filter((k) => k === "*" || k.startsWith("data-analysis:") || k.startsWith("push:")))];
      const brands = permissions.filter((k) => k.startsWith("data-analysis:brand:")).map((k) => k.slice("data-analysis:brand:".length));
      const categories = permissions.filter((k) => k.startsWith("data-analysis:category:")).map((k) => k.slice("data-analysis:category:".length));
      const data_scope = { brands, categories, branch_nums: [...expanded.branch_nums ?? []] };
      const fields = { cost: permissions.includes("data-analysis:field:cost") };
      return {
        ...ctx.legacy,
        // H5：08-15 保留字段（role_code 等）全量透传
        permissions,
        // B2 资源串
        groups: oidcGroups,
        // F4：原生 token 全路径（判定用，禁中文 label 派生）
        data_scope,
        // B1：空段 = deny 语义载体
        fields,
        catalog_v: ctx.catalogV
      };
    }
    module2.exports = { buildClaims: buildClaims2, collapseFullStore: collapseFullStore2, resolveGroupBranches: resolveGroupBranches2 };
    var FRIENDLY_TO_KEY = {
      "\u6307\u6807\u6982\u89C8": "data-analysis:view-board:kpi",
      "\u54C1\u724C\xD7\u6307\u6807": "data-analysis:view-board:brand",
      "\u95E8\u5E97\u6218\u533A": "data-analysis:view-board:region",
      "\u5546\u54C1 TOP": "data-analysis:view-board:item-top",
      "\u7C7B\u522B\u51FA\u5E93": "data-analysis:view-board:category",
      "\u4F9B\u5E94\u94FE\u51FA\u5E93": "data-analysis:view-board:supply-chain",
      "\u5916\u90E8\u6279\u53D1": "data-analysis:view-board:wholesale",
      "\u95E8\u5E97\u96F6\u552E": "data-analysis:view-kpi:sale",
      "\u95E8\u5E97\u914D\u9001": "data-analysis:view-kpi:delivery",
      "\u4F9B\u5E94\u94FE\u51FA\u5E93\u91D1\u989D": "data-analysis:view-kpi:outbound_amt",
      "\u4F9B\u5E94\u94FE\u6BDB\u5229": "data-analysis:view-kpi:outbound_profit",
      "\u603B\u914D\u9500\u6BD4": "data-analysis:view-kpi:delivery_sale_ratio",
      "\u6BDB\u5229\u7387": "data-analysis:view-kpi:outbound_margin"
    };
    function normalizeFriendlyPerm(value) {
      return FRIENDLY_TO_KEY[value] ?? value;
    }
    module2.exports = { buildClaims: buildClaims2, collapseFullStore: collapseFullStore2, resolveGroupBranches: resolveGroupBranches2, FRIENDLY_TO_KEY, normalizeFriendlyPerm };
    function resolveGroupBranches2(groupPaths, maps, knownDepts) {
      const deptSet = knownDepts instanceof Set ? knownDepts : null;
      const results = /* @__PURE__ */ new Set();
      for (const path of groupPaths ?? []) {
        const g = String(path).split("/").pop();
        const rows = (maps ?? []).filter((m) => m.group_id === g && m.branch_number);
        if (rows.length > 0) {
          for (const m of rows) results.add(m.branch_number);
          continue;
        }
        const asRegion = (maps ?? []).some((m) => m.group_type === "store" && m.group_id.startsWith(g + "-"));
        if (asRegion) {
          for (const m of maps) {
            if (m.group_type === "store" && m.group_id.startsWith(g + "-") && m.branch_number) results.add(m.branch_number);
          }
          continue;
        }
        if (deptSet && deptSet.has(g)) continue;
        return { branch_nums: [], ok: false, error: `unknown group: ${g}` };
      }
      return { branch_nums: [...results].sort(), ok: true };
    }
    function collapseFullStore2(branchNums, allStoreNums) {
      const uniq = [...new Set(branchNums ?? [])];
      const universe = new Set(allStoreNums ?? []);
      if (uniq.length === 0 || universe.size === 0) return [...uniq].sort();
      const covered = uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
      return covered ? ["*"] : [...uniq].sort();
    }
  }
});

// functions/wecom-oidc-callback/index.js
var { signJwt } = require_jwt();
var { corsHeaders, json } = require_cors();
var { buildClaims, collapseFullStore, resolveGroupBranches } = require_claims();
function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - b64.length % 4) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
async function fetchAllObjects(issuer, accessToken, userId) {
  try {
    const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    const res = await fetch(`${issuer}/api/get-all-objects${q}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      console.error(
        "wecom-oidc-callback: get-all-objects http",
        res.status,
        (await res.text().catch(() => "")).slice(0, 200)
      );
      return null;
    }
    const data = await res.json();
    const arr = data && data.data;
    return Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : null;
  } catch (e) {
    console.error("wecom-oidc-callback: get-all-objects failed", e);
    return null;
  }
}
async function expandGroupsToBranches(groupPaths, pgrstUrl) {
  try {
    const mapsRes = await fetch(
      `${pgrstUrl}/maps_branch_group?is_active=eq.true&select=group_id,group_type,branch_number`,
      { headers: { "Content-Type": "application/json" } }
    );
    if (!mapsRes.ok) {
      return { branch_nums: [], ok: false, error: `maps_branch_group http ${mapsRes.status}` };
    }
    const maps = await mapsRes.json();
    if (!Array.isArray(maps)) {
      return { branch_nums: [], ok: false, error: "maps_branch_group non-array" };
    }
    let knownDepts;
    try {
      const deptRes = await fetch(
        `${pgrstUrl}/org_departments?is_active=eq.true&select=name`,
        { headers: { "Content-Type": "application/json" } }
      );
      if (deptRes.ok) {
        const depts = await deptRes.json();
        if (Array.isArray(depts)) knownDepts = new Set(depts.map((d) => d.name).filter(Boolean));
      }
    } catch (e) {
      console.error("wecom-oidc-callback: org_departments fetch failed", e);
    }
    const resolved = resolveGroupBranches(groupPaths, maps, knownDepts);
    if (resolved.ok !== true) return resolved;
    const universe = [...new Set(maps.map((m) => m.branch_number).filter(Boolean))];
    return { branch_nums: collapseFullStore(resolved.branch_nums, universe), ok: true };
  } catch (e) {
    return { branch_nums: [], ok: false, error: `maps_branch_group fetch failed: ${e}` };
  }
}
module.exports = async function(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  const issuer = Deno.env.get("CASDOOR_ISSUER");
  const clientId = Deno.env.get("CASDOOR_CLIENT_ID");
  const clientSecret = Deno.env.get("CASDOOR_CLIENT_SECRET");
  if (!issuer || !clientId || !clientSecret) {
    return json({ error: "Casdoor secrets not configured" }, 500);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const state = body.state;
    if (!code || !redirectUri) return json({ error: "missing code or redirect_uri" }, 400);
    const STATE_RE = /^[A-Za-z0-9_-]{32,}::/;
    if (typeof state !== "string" || !STATE_RE.test(state)) {
      return json({ error: "invalid_state" }, 400);
    }
    const REDIRECT_URI_RE = /^(https:\/\/[^\s]*\/auth\/callback|http:\/\/localhost(:\d+)?\/auth\/callback)$/;
    if (!REDIRECT_URI_RE.test(redirectUri)) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    const tokenRes = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.error(
        "wecom-oidc-callback: casdoor token exchange failed",
        { status: tokenRes.status, body: JSON.stringify(tokenData).slice(0, 500) }
      );
      return json({ error: "failed_to_get_casdoor_token" }, 502);
    }
    const userRes = await fetch(`${issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const userData = await userRes.json();
    const wecomUserId = userData.sub;
    if (!wecomUserId) {
      console.error(
        "wecom-oidc-callback: userinfo missing sub",
        { status: userRes.status, respBody: JSON.stringify(userData).slice(0, 500) }
      );
      return json({ error: "failed_to_get_wecom_id" }, 401);
    }
    let casdoorRoles = [];
    if (Array.isArray(userData.roles)) {
      casdoorRoles = userData.roles.filter((r) => typeof r === "string" && r.length > 0);
    } else if (typeof userData.roles === "string" && userData.roles.length > 0) {
      casdoorRoles = [userData.roles];
    }
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY")
    });
    const { data: user, error: userErr } = await client.database.from("org_users").select("is_active, department_ids, name").eq("wecom_id", wecomUserId).single();
    if (userErr && !user) {
      console.error("wecom-oidc-callback: org_users query error", userErr?.message ?? userErr);
    }
    if (user && user.is_active === false) {
      return json({ error: "user_inactive" }, 403);
    }
    const departmentIds = user?.department_ids || [];
    const userName = user?.name || wecomUserId;
    if (casdoorRoles.length > 0) {
      try {
        await client.database.from("org_users").update({
          role_codes: casdoorRoles,
          casdoor_synced_at: (/* @__PURE__ */ new Date()).toISOString()
        }).eq("wecom_id", wecomUserId).eq("casdoor_writer", "auto");
      } catch (e) {
        console.error("role_codes mirror write failed", e);
      }
    }
    const pgrstUrl = Deno.env.get("POSTGREST_URL") || "http://postgrest:3000";
    let perms = {};
    try {
      const permRes = await fetch(`${pgrstUrl}/rpc/get_user_perms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_wecom_id: wecomUserId })
      });
      if (permRes.ok) perms = await permRes.json() || {};
      else console.error("get_user_perms http", permRes.status, await permRes.text().catch(() => ""));
    } catch (e) {
      console.error("get_user_perms failed", e);
    }
    const tokenPayload = decodeJwtPayload(accessToken) || {};
    const oidcGroups = Array.isArray(tokenPayload.groups) ? tokenPayload.groups : Array.isArray(userData.groups) ? userData.groups : null;
    if (!oidcGroups) {
      console.error("wecom-oidc-callback: groups claim missing, login denied (C2)");
      return json({ error: "group_claim_missing_login_denied" }, 503);
    }
    const casdoorUserId = tokenPayload.owner && tokenPayload.name ? `${tokenPayload.owner}/${tokenPayload.name}` : tokenPayload.sub;
    const reachable = await fetchAllObjects(issuer, accessToken, casdoorUserId);
    const expandResult = await expandGroupsToBranches(oidcGroups, pgrstUrl);
    const claims = buildClaims({
      oidcToken: { groups: oidcGroups },
      reachable,
      expandResult,
      catalogV: Deno.env.get("CATALOG_V") ?? "0",
      legacy: {
        // 08-15 保留字段（H5）全量透传——仍从 get_user_perms 读，缺字段兜底语义不变
        role_code: perms.role_code ?? null,
        default_landing: perms.default_landing || "/",
        default_metric: perms.default_metric || "sale",
        visible_panels: perms.visible_panels || [],
        departments: departmentIds,
        roles: casdoorRoles
        // Task 13: Casdoor 角色码（string[]）
      }
    });
    if (!claims) {
      console.error(
        "wecom-oidc-callback: group scope unavailable, login denied",
        { expandError: expandResult?.error ?? null, reachable: Array.isArray(reachable) ? reachable.length : null }
      );
      return json({ error: "group scope unavailable, login denied" }, 503);
    }
    try {
      await client.database.from("org_users").update({
        groups: oidcGroups
      }).eq("wecom_id", wecomUserId);
    } catch (e) {
      console.error("groups projection mirror write failed", e);
    }
    const now = Math.floor(Date.now() / 1e3);
    const jwt = await signJwt({
      sub: wecomUserId,
      role: "authenticated",
      ...claims,
      iss: "casdoor-oidc",
      iat: now,
      exp: now + 7 * 86400
    }, Deno.env.get("JWT_SECRET"));
    return json({ ok: true, wecom_userid: wecomUserId, wecom_name: userName, access_token: jwt });
  } catch (e) {
    console.error("wecom-oidc-callback error:", e);
    return json({ error: "internal_error" }, 500);
  }
};
