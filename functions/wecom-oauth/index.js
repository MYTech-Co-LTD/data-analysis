// functions/wecom-oauth/index.js
// 企业微信 OAuth 回调处理（H5 网页授权 snsapi_base）：
//   code → 企微 userid → upsert org_users → 签发会话
// 框架状态：真实联调待「可信回调域名」就绪（企微后台配置 + 公网可达）。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID（与 wecom-push 共用）
// 前端发起授权（移动端 H5）：
//   https://open.weixin.qq.com/connect/oauth2/authorize?appid=${CORPID}
//     &redirect_uri=${APP_URL}/auth/callback&response_type=code&scope=snsapi_base
//     &state=xxx&agentid=${AGENTID}#wechat_redirect
// 共享打包（P3 铺开）：b64url/signJwt 与 corsHeaders/json 提取到 ../_shared（jwt.ts / cors.ts）。
// 源码直接 require 共享模块，部署/校验时由 esbuild --bundle --format=cjs 打进单文件
// （scripts/deploy-functions.sh 用 .bundle 产物或本目录 index.bundle.js 部署；InsForge 运行时模型不变）。
// 用 JWT_SECRET 签 role=authenticated 的 token，PostgREST 验签后切到 authenticated role。
const { signJwt } = require("../_shared/jwt");
const { corsHeaders, json } = require("../_shared/cors");

module.exports = async function (req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_SECRET");
  const agentId = Deno.env.get("WECOM_AGENT_ID");
  if (!corpId || !corpSecret || !agentId) {
    return json({ error: "WECOM secrets not configured" }, 500);
  }

  try {
    const url = new URL(req.url);
    let code = url.searchParams.get("code");
    if (!code && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      code = body.code;
    }
    if (!code) {
      return json({ error: "missing oauth code" }, 400);
    }

    // 1. 获取企微 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
    );
    const tokenData = await tokenRes.json();
    const wecomToken = tokenData.access_token;
    if (!wecomToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. code → 企业微信 userid
    const userRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${wecomToken}&code=${code}`,
    );
    const userData = await userRes.json();
    const wecomUserId = userData.userid;
    if (!wecomUserId) {
      return json({ error: "failed_to_get_userid", detail: userData }, 401);
    }

    // 3. upsert org_users + 查询部门信息
    // 注意：INSFORGE_API_BASE 是容器内地址（deno -> insforge）
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });

    // 先尝试 upsert（确保用户存在）
    await client.database.from("org_users").upsert(
      { wecom_id: wecomUserId },
      { onConflict: "wecom_id" },
    );

    // 查询用户的部门和姓名信息
    const { data: user, error: userError } = await client.database
      .from("org_users")
      .select("department_ids, name")
      .eq("wecom_id", wecomUserId)
      .single();

    const departmentIds = user?.department_ids || [];
    const userName = user?.name || wecomUserId;  // 如果没有姓名则用 userid

    // 4. 调 get_user_perms 拿合并后权限（角色 role_code + 四维 + UI 配置）
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
    } catch (e) {
      console.error("get_user_perms failed", e);
    }

    // 5. 签发 access_token（role=authenticated，携带部门 + 权限 claim）
    //    claim 八字段从 perms 读，缺字段兜底保证旧用户/新用户都能登录：
    //      role_code=null（前端再走默认）、四维默认全权 ['*']、
    //      can_see_cost=false（敏感默认拒绝）、UI 默认值最小可用。
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await signJwt(
      {
        sub: wecomUserId,
        role: "authenticated",
        departments: departmentIds,  // 部门 ID 数组（兼容旧字段）
        // 权限 claim（Task 4 新增）
        role_code: perms.role_code ?? null,
        // T7/M1：兜底恒 deny（`?? []` / `?? false`，禁 `|| ["*"]` fail-open）——旧兜底会在
        //   get_user_perms 顶层 key 为 [] 或缺失时把「无授权」放大成全权；双形下读 data_scope/fields 同源同值。
        branch_nums: perms.data_scope?.branch_nums ?? perms.branch_nums ?? [],
        brands: perms.data_scope?.brands ?? perms.brands ?? [],
        categories: perms.data_scope?.categories ?? perms.categories ?? [],
        can_see_cost: perms.fields?.cost ?? perms.can_see_cost ?? false,
        data_scope: perms.data_scope ?? { brands: [], categories: [], branch_nums: [] },
        fields: perms.fields ?? { cost: false },
        default_landing: perms.default_landing || "/",
        default_metric: perms.default_metric || "sale",
        visible_panels: perms.visible_panels || [],
        iss: "wecom-oauth",
        iat: now,
        exp: now + 7 * 86400,
      },
      Deno.env.get("JWT_SECRET"),
    );
    return json({ ok: true, wecom_userid: wecomUserId, wecom_name: userName, access_token: accessToken });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
