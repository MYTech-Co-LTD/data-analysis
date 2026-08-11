// functions/_shared/cors.ts
// 共享 CORS 头 + JSON 响应 helper（试点：共享打包）。
// - CommonJS module.exports；由 esbuild --bundle 打进部署单文件。
// - 来源：从 functions/wecom-oauth/index.js 提取（corsHeaders + json，逐字一致）。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

module.exports = { corsHeaders, json };
