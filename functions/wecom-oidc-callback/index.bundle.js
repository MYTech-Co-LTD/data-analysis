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

// functions/wecom-oidc-callback/index.js
var { signJwt } = require_jwt();
var { corsHeaders, json } = require_cors();
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
    const permKeys = [];
    if (perms.branch_nums) permKeys.push("branch_nums");
    if (perms.brands) permKeys.push("brands");
    if (perms.categories) permKeys.push("categories");
    if (perms.can_see_cost) permKeys.push("can_see_cost");
    const now = Math.floor(Date.now() / 1e3);
    const jwt = await signJwt({
      sub: wecomUserId,
      role: "authenticated",
      departments: departmentIds,
      role_code: perms.role_code ?? null,
      branch_nums: perms.branch_nums || ["*"],
      brands: perms.brands || ["*"],
      categories: perms.categories || ["*"],
      can_see_cost: perms.can_see_cost ?? false,
      default_landing: perms.default_landing || "/",
      default_metric: perms.default_metric || "sale",
      visible_panels: perms.visible_panels || [],
      roles: casdoorRoles,
      // Task 13: Casdoor 角色码（string[]）
      permissions: permKeys,
      // Task 13: 已授权维度 key 列表（additive）
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
