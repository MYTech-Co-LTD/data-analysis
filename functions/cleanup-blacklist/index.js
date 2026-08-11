// functions/cleanup-blacklist/index.js
// 定时清理已过期的黑名单记录
// 建议 schedule：每日 03:00 执行
// 所需 secrets：JWT_SECRET（用于签 service token）
//
// 共享打包试点（P3）：b64url/signJwt 与 corsHeaders/json 已提取到 ../_shared（jwt.ts / cors.ts）。
// 源码直接 require 共享模块，部署/校验时由 esbuild --bundle --format=cjs 打进单文件
// （scripts/deploy-functions.sh 用 .bundle 产物或本目录 index.bundle.js 部署；InsForge 运行时模型不变）。
const { signJwt } = require("../_shared/jwt");
const { corsHeaders, json } = require("../_shared/cors");

module.exports = async function (req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret) {
    return json({ error: "JWT_SECRET not set" }, 500);
  }

  try {
    // 签临时 authenticated JWT
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = await signJwt(
      { sub: "cleanup-blacklist", role: "authenticated", iss: "cleanup-blacklist", iat: now, exp: now + 300 },
      jwtSecret,
    );

    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: serviceToken,
    });

    // 删除已过期的黑名单记录
    const { data, error } = await client.database
      .from("token_blacklist")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id"); // 返回被删除的记录数以统计

    if (error) {
      return json({ error: "cleanup_failed", detail: error }, 502);
    }

    return json({
      ok: true,
      cleaned: data?.length || 0,
      message: `Cleaned ${data?.length || 0} expired tokens from blacklist`,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
