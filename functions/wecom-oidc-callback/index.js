// functions/wecom-oidc-callback/index.js
// Casdoor OIDC authorization code → 换 token → userinfo(sub=wecom_id)
//   → upsert org_users + get_user_perms → 签 PostgREST JWT(role=authenticated)
// 复用 wecom-oauth 的 signJwt + claims 结构(JWT_SECRET / PostgREST RLS 不变)。
// 接管 wecom-oauth 的登录职责：web 不再直连企微 OAuth，改跳 Casdoor 统一身份，
// Casdoor 内部走企微 provider(Use id as name → sub=wecom_id)，本 function 只收 Casdoor code。
// 所需 secrets: CASDOOR_ISSUER / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / JWT_SECRET
//              ANON_KEY / INSFORGE_API_BASE / POSTGREST_URL
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno），
//       不要用 ESM 的 import/export（与 wecom-oauth/wecom-push 同款）。

// 共享打包（P3 铺开）：b64url/signJwt 与 corsHeaders/json 提取到 ../_shared（jwt.ts / cors.ts）。
// 源码直接 require 共享模块，部署/校验时由 esbuild --bundle --format=cjs 打进单文件
// （scripts/deploy-functions.sh 用 .bundle 产物或本目录 index.bundle.js 部署；InsForge 运行时模型不变）。
const { signJwt } = require("../_shared/jwt");
const { corsHeaders, json } = require("../_shared/cors");

module.exports = async function (req) {
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
    const redirectUri = body.redirect_uri; // 与 web 跳 Casdoor 时用的 redirect_uri 必须一致
    if (!code || !redirectUri) return json({ error: "missing code or redirect_uri" }, 400);

    // 1. Casdoor code → access_token
    const tokenRes = await fetch(`${issuer}/api/login/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return json({ error: "failed_to_get_casdoor_token", detail: tokenData }, 502);

    // 2. userinfo → sub(wecom_id;依赖 provider 配了 Use id as name)
    const userRes = await fetch(`${issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userData = await userRes.json();
    const wecomUserId = userData.sub;
    if (!wecomUserId) return json({ error: "failed_to_get_wecom_id", detail: userData }, 401);

    // 3. 查 org_users 拿部门/姓名(只读,不 upsert)。
    //    org_users 由企微通讯录同步(App B 回调 + 每日全量)独占维护,登录不写,避免双写不一致。
    //    createClient 全局注入。通讯录未同步到该用户时 user=null → departmentIds/name 走兜底。
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });
    const { data: user } = await client.database
      .from("org_users").select("department_ids, name")
      .eq("wecom_id", wecomUserId).single();
    const departmentIds = user?.department_ids || [];
    const userName = user?.name || wecomUserId;

    // 4. get_user_perms(复用 wecom-oauth 同款直连 postgrest)
    //    直连 postgrest（绕过 SDK/网关）：运行时 SDK 无 database.rpc，网关无 /rest/v1 路由(404)。
    //    get_user_perms 是 SECURITY DEFINER + GRANT 给 anon，postgrest 无 Authorization 默认 anon 可执行。
    //    deno 与 postgrest 同 docker 网络。失败时 perms={} 兜底，登录不挂。
    const pgrstUrl = Deno.env.get("POSTGREST_URL") || "http://postgrest:3000";
    let perms = {};
    try {
      const permRes = await fetch(`${pgrstUrl}/rpc/get_user_perms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_wecom_id: wecomUserId }),
      });
      if (permRes.ok) perms = await permRes.json() || {};
      else console.error("get_user_perms http", permRes.status, await permRes.text().catch(() => ""));
    } catch (e) { console.error("get_user_perms failed", e); }

    // 5. 签 PostgREST JWT(claims 与 wecom-oauth 完全一致 → RLS 不变；仅 iss 区分来源)
    //    claim 八字段从 perms 读，缺字段兜底保证旧用户/新用户都能登录：
    //      role_code=null（前端再走默认）、四维默认全权 ['*']、
    //      can_see_cost=false（敏感默认拒绝）、UI 默认值最小可用。
    const now = Math.floor(Date.now() / 1000);
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
      iss: "casdoor-oidc",
      iat: now,
      exp: now + 7 * 86400,
    }, Deno.env.get("JWT_SECRET"));

    return json({ ok: true, wecom_userid: wecomUserId, wecom_name: userName, access_token: jwt });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
