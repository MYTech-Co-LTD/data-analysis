// functions/_shared/cors.ts
// 共享 CORS 头 + JSON 响应 helper（共享打包，P3 铺开：全 5 个引用 function 共用）。
// - CommonJS module.exports；由 esbuild --bundle 打进部署单文件。
// - 来源：从 functions/wecom-oauth/index.js 提取（corsHeaders + json，逐字一致）。
// - json(data, status, extraHeaders?)：extraHeaders 可选，供契约不同的 function 覆盖 CORS 键
//   （如 agent-query：methods 仅 POST/OPTIONS、Allow-Headers 多 x-agent-key；覆盖后响应头逐字节不变）。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

module.exports = { corsHeaders, json };
