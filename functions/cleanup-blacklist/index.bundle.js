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
    function json2(data, status) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders2, "Content-Type": "application/json" }
      });
    }
    module2.exports = { corsHeaders: corsHeaders2, json: json2 };
  }
});

// functions/cleanup-blacklist/index.js
var { signJwt } = require_jwt();
var { corsHeaders, json } = require_cors();
module.exports = async function(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret) {
    return json({ error: "JWT_SECRET not set" }, 500);
  }
  try {
    const now = Math.floor(Date.now() / 1e3);
    const serviceToken = await signJwt(
      { sub: "cleanup-blacklist", role: "authenticated", iss: "cleanup-blacklist", iat: now, exp: now + 300 },
      jwtSecret
    );
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: serviceToken
    });
    const { data, error } = await client.database.from("token_blacklist").delete().lt("expires_at", (/* @__PURE__ */ new Date()).toISOString()).select("id");
    if (error) {
      return json({ error: "cleanup_failed", detail: error }, 502);
    }
    return json({
      ok: true,
      cleaned: data?.length || 0,
      message: `Cleaned ${data?.length || 0} expired tokens from blacklist`
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
