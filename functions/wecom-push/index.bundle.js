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

// functions/wecom-push/index.js
var { signJwt } = require_jwt();
var { corsHeaders, json } = require_cors();
module.exports = async function(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
  const agentId = Deno.env.get("WECOM_OPS_AGENT_ID");
  if (!corpId || !corpSecret || !agentId) {
    return json(
      { error: "WECOM_CORP_ID/WECOM_OPS_SECRET/WECOM_OPS_AGENT_ID secrets not set" },
      500
    );
  }
  try {
    const body = await req.json().catch(() => ({}));
    const toUser = body.to_user || "@all";
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }
    const now = Math.floor(Date.now() / 1e3);
    const token = await signJwt(
      { sub: "wecom-push", role: "authenticated", iss: "wecom-push", iat: now, exp: now + 300 },
      Deno.env.get("JWT_SECRET")
    );
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: token
    });
    const { data: reports, error } = await client.database.from("reports").select("name,metrics,updated_at").limit(5);
    if (error) return json({ error: "db_query_failed", detail: error }, 502);
    const summary = (reports ?? []).map((r) => {
      const m = (r.metrics ?? []).map((x) => `${x.name} ${x.value}`).join("    ");
      return `\u{1F4CA}${r.name}
${m}`;
    }).join("\n\n\u2014\u2014\u2014\u2014\u2014\u2014\n\n");
    const sendRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: toUser,
          msgtype: "textcard",
          agentid: Number(agentId),
          textcard: {
            title: "\u{1F4CA} \u6570\u636E\u5206\u6790\u5E73\u53F0 \xB7 \u62A5\u8868\u63A8\u9001",
            description: summary || "\u6682\u65E0\u62A5\u8868\u6570\u636E",
            url: Deno.env.get("REPORT_URL") || "http://localhost:3000"
          }
        })
      }
    );
    const sendData = await sendRes.json();
    await client.database.from("query_logs").insert([
      {
        query_type: "wecom_push",
        status: sendData.errcode === 0 ? "success" : "failed",
        error_message: sendData.errcode === 0 ? null : JSON.stringify(sendData)
      }
    ]);
    return json({ ok: sendData.errcode === 0, to_user: toUser, detail: sendData });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
