// functions/_shared/jwt.ts
// 共享 HS256 JWT 签名模块（试点：共享打包，见 DESIGN 的 P3 functions 试点）。
// - CommonJS module.exports，与现有 function（module.exports = async function）一致。
// - 由 esbuild --bundle --format=cjs 打进各 function 的部署单文件（见 scripts/deploy-functions.sh），
//   InsForge 运行时模型不变：部署产物仍是单文件 CJS。
// - 运行时全局依赖：btoa / TextEncoder / crypto.subtle（Deno & Node 18+ 均可用）。
// - 来源：从 functions/wecom-oauth/index.js 提取（b64url + signJwt，逐字一致）。
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(payload, secret) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

module.exports = { b64url, signJwt };
