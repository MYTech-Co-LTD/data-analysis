// functions/wecom-oidc-callback/index.js
// Casdoor OIDC authorization code → 换 token → userinfo(sub=wecom_id)
//   → upsert org_users + get_user_perms → 签 PostgREST JWT(role=authenticated)
// 复用 wecom-oauth 的 signJwt + claims 结构(JWT_SECRET / PostgREST RLS 不变)。
// 接管 wecom-oauth 的登录职责：web 不再直连企微 OAuth，改跳 Casdoor 统一身份，
// Casdoor 内部走企微 provider(Use id as name → sub=wecom_id)，本 function 只收 Casdoor code。
// 所需 secrets: CASDOOR_ISSUER / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / JWT_SECRET
//              ANON_KEY / INSFORGE_API_BASE / POSTGREST_URL
//              env（非 secret）: CATALOG_V（catalog 版本戳，缺省 '0' = 慢路径校验，M3.5 非锁死）
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno），
//       不要用 ESM 的 import/export（与 wecom-oauth/wecom-push 同款）。
//
// W3 / Task 11（spec §5.4）：claims 构建提为 claims.js 纯函数 buildClaims(ctx)，本文件只做三段组装：
//   ① 原生 token groups（useGroupPathInToken 全路径 claim，F4——Casdoor 无用户组查询路由，组信息只从 token 读）
//   ② get-all-objects 可达对象（policy 侧，F11——与 get-resources 注册表语义区分）
//   ③ 门店范围展开（范围|X 资源唯一真相，expandScopeResources 读 maps+dim_branch；
//      2026-08-18 废除组织架构推导——无范围资源 = branch_nums: [] = B1 空集 deny）
//   三段任一失败 → buildClaims 返回 null → 503 整体失败（C2 fail-close，禁半截 claims）。
//   claims 新增 groups/data_scope{brands,categories,branch_nums}/fields{cost}/catalog_v；
//   permissions 迁移为资源串（B2）；顶层旧四维 key = 全维非空镜像（B6/M1，只写非空值）。

// 共享打包（P3 铺开）：b64url/signJwt 与 corsHeaders/json 提取到 ../_shared（jwt.ts / cors.ts）。
// 源码直接 require 共享模块，部署/校验时由 esbuild --bundle --format=cjs 打进单文件
// （scripts/deploy-functions.sh 用 .bundle 产物或本目录 index.bundle.js 部署；InsForge 运行时模型不变）。
const { signJwt } = require("../_shared/jwt");
const { corsHeaders, json } = require("../_shared/cors");
const { buildClaims, collapseFullStore, resolveScopeKeys, normalizeFriendlyPerm } = require("./claims");

// JWT payload 解码（不验签——token 已由 Casdoor 签发且经 client_secret 换取，此处只读 claims；
// access_token 非 JWT 形态时返回 null，调用方按 C2 处理）。
// 注意 atob 产物是 latin-1 binary string，组名含中文——必须经 TextDecoder 按 UTF-8 还原，
// 直接 JSON.parse(atob(...)) 会把全路径组名解成 mojibake → 展开全部 unknown → 整站 503。
function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// ② get-all-objects（F11：policy 侧可达对象，owner 任意 permission 的 casbin objects 并集）。
//    userId 要求 owner/name 双段格式（如 "shanhai/ZhangDuo"，上游 GetOwnerAndNameFromId 按 "/" 切 2 段）；
//    JWT 的 sub 只是 user.Id 列（本部署库为裸名，直传报 wrong token count → data=null），
//    由调用方从 token 的 owner/name claims 构造，缺失时回退 sub（老格式兼容）。
//    返回 string[]；任何失败返回 null（由 buildClaims 判 C2 → 503）。
async function fetchAllObjects(issuer, accessToken, userId) {
  try {
    const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    const res = await fetch(`${issuer}/api/get-all-objects${q}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error("wecom-oidc-callback: get-all-objects http", res.status,
        (await res.text().catch(() => "")).slice(0, 200));
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

// ③ 范围资源展开（2026-08-18 门店范围显式授权，范围资源唯一真相）：
//    输入 = get-all-objects 里归一出的 data-analysis:branch:X 键（'*' / 包名 / branch_number / 门店中文名）。
//    maps + dim_branch 各拉一次；resolveScopeKeys 纯解析（claims.js）；全店覆盖仍走 collapseFullStore 收敛。
//    输出 {branch_nums, ok, error}——buildClaims 消费；未知键 ok:false → C2 登录 503。
async function expandScopeResources(scopeKeys, pgrstUrl) {
  try {
    const mapsRes = await fetch(
      `${pgrstUrl}/maps_branch_group?is_active=eq.true&select=group_id,group_type,branch_number`,
      { headers: { "Content-Type": "application/json" } },
    );
    if (!mapsRes.ok) {
      return { branch_nums: [], ok: false, error: `maps_branch_group http ${mapsRes.status}` };
    }
    const maps = await mapsRes.json();
    if (!Array.isArray(maps)) {
      return { branch_nums: [], ok: false, error: "maps_branch_group non-array" };
    }
    // 门店中文名解析用 dim_branch（branch_name 唯一命中；重名/未命中 fail-close）
    const dimRes = await fetch(
      `${pgrstUrl}/dim_branch?select=branch_number,branch_name`,
      { headers: { "Content-Type": "application/json" } },
    );
    if (!dimRes.ok) {
      return { branch_nums: [], ok: false, error: `dim_branch http ${dimRes.status}` };
    }
    const dimBranches = await dimRes.json();
    if (!Array.isArray(dimBranches)) {
      return { branch_nums: [], ok: false, error: "dim_branch non-array" };
    }
    const resolved = resolveScopeKeys(scopeKeys, maps, dimBranches);
    if (resolved.ok !== true) return resolved;
    const universe = [...new Set(maps.map((m) => m.branch_number).filter(Boolean))];
    return { branch_nums: collapseFullStore(resolved.branch_nums, universe), ok: true };
  } catch (e) {
    return { branch_nums: [], ok: false, error: `scope expand fetch failed: ${e}` };
  }
}

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
    const state = body.state;
    if (!code || !redirectUri) return json({ error: "missing code or redirect_uri" }, 400);

    // B1 CSRF：state 必须由 web /auth/start 生成（`${nonce}::${path}`，nonce ≥32 位安全字符）。
    // nonce=随机会话标识，攻击者无法预知 → 认证响应无法被重放到他人会话。
    const STATE_RE = /^[A-Za-z0-9_-]{32,}::/;
    if (typeof state !== "string" || !STATE_RE.test(state)) {
      return json({ error: "invalid_state" }, 400);
    }

    // redirect_uri 白名单：必须是本平台回调（https，或本地 http://localhost 调试），
    // 不允许把 code 转发到任意站点（防 token 泄露给攻击者回调）。
    const REDIRECT_URI_RE = /^(https:\/\/[^\s]*\/auth\/callback|http:\/\/localhost(:\d+)?\/auth\/callback)$/;
    if (!REDIRECT_URI_RE.test(redirectUri)) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }

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
    if (!accessToken) {
      // 脱敏：细节只留服务器日志，不回给客户端（防泄露 Casdoor 内部地址/错误结构）。
      console.error("wecom-oidc-callback: casdoor token exchange failed",
        { status: tokenRes.status, body: JSON.stringify(tokenData).slice(0, 500) });
      return json({ error: "failed_to_get_casdoor_token" }, 502);
    }

    // 2. userinfo → sub(wecom_id;依赖 provider 配了 Use id as name)
    //    Casdoor userinfo 可能含 roles（string[]）：用户在 Casdoor 中分配的角色码。
    const userRes = await fetch(`${issuer}/api/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userData = await userRes.json();
    // sub 即 wecom_id 的前提是 Casdoor 企微 provider「Use id as name」且用户 id=wecom userid
    // （老用户手建时 id=name）。但 2026-08 后 Casdoor 新注册用户 id 是 UUID（如 ZhengXin），
    // sub 变 UUID → org_users 查不到 → 姓名回退成 UUID、perms 全丢。
    // 解法：sub 在 org_users 无匹配时，依次用 preferred_username / name claim（Casdoor
    // 携带的登录名 = 企微 userid）重试；仍无匹配才沿用 sub（走原兜底分支）。
    let wecomUserId = userData.sub;
    if (!wecomUserId) {
      console.error("wecom-oidc-callback: userinfo missing sub",
        { status: userRes.status, respBody: JSON.stringify(userData).slice(0, 500) });
      return json({ error: "failed_to_get_wecom_id" }, 401);
    }
    const aliasCandidates = [userData.preferred_username, userData.name]
      .filter((v) => typeof v === "string" && v.length > 0 && v !== wecomUserId);

    // 2b. 提取 roles claim（Casdoor JWT userinfo 可能含 roles 字段）
    //     兼容 string[] / string / 缺失三种情况，统一为 string[]
    let casdoorRoles = [];
    if (Array.isArray(userData.roles)) {
      casdoorRoles = userData.roles.filter((r) => typeof r === "string" && r.length > 0);
    } else if (typeof userData.roles === "string" && userData.roles.length > 0) {
      casdoorRoles = [userData.roles];
    }

    // 3. 查 org_users 拿部门/姓名(只读,不 upsert)。
    //    org_users 由企微通讯录同步(App B 回调 + 每日全量)独占维护,登录不写,避免双写不一致。
    //    createClient 全局注入。通讯录未同步到该用户时 user=null → departmentIds/name 走兜底。
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });
    const selectUser = (id) =>
      client.database.from("org_users").select("is_active, department_ids, name")
        .eq("wecom_id", id).single();

    let { data: user, error: userErr } = await selectUser(wecomUserId);
    if ((userErr || !user) && aliasCandidates.length > 0) {
      // sub(UUID) 兜底：用登录名 claim 逐个重试，命中即采用为 wecom_userid
      for (const alias of aliasCandidates) {
        const retry = await selectUser(alias);
        if (!retry.error && retry.data) {
          console.log("wecom-oidc-callback: sub miss, resolved wecom_id by claim",
            { aliasSource: alias === userData.preferred_username ? "preferred_username" : "name" });
          wecomUserId = alias;
          user = retry.data;
          userErr = null;
          break;
        }
      }
    }
    if (userErr && !user) {
      console.error("wecom-oidc-callback: org_users query error", userErr?.message ?? userErr);
    }
    // 离职闸：通讯录已标 is_active=false 的用户拒绝签发新 token（防拿幽灵账号继续登录）。
    if (user && user.is_active === false) {
      return json({ error: "user_inactive" }, 403);
    }
    const departmentIds = user?.department_ids || [];
    const userName = user?.name || wecomUserId;

    // 3b. 登录写穿镜像：Casdoor roles → org_users.role_codes（Task 13 M-1 镜像列）
    //     casdoor_writer='auto' 时由登录写穿；'manual' 时跳过（防手工配置橡皮擦，169 设计语义）
    if (casdoorRoles.length > 0) {
      try {
        await client.database.from("org_users").update({
          role_codes: casdoorRoles,
          casdoor_synced_at: new Date().toISOString(),
        }).eq("wecom_id", wecomUserId).eq("casdoor_writer", "auto");
      } catch (e) { console.error("role_codes mirror write failed", e); }
    }

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

    // 5. W3 三段组装（Task 11，spec §5.4）→ buildClaims → 签 PostgREST JWT。
    //    任一段失败 → buildClaims 返回 null → 503 整体失败（C2 fail-close，禁半截 claims）。
    // ① 原生 token groups：Casdoor 开 useGroupPathInToken 后 access_token(JWT) 自带 groups 全路径 claim
    //    （token_jwt.go）；用户组查询路由不存在，禁调用（F4）。userinfo.groups 仅作兼容回退。
    const tokenPayload = decodeJwtPayload(accessToken) || {};
    const oidcGroups = Array.isArray(tokenPayload.groups) ? tokenPayload.groups
      : (Array.isArray(userData.groups) ? userData.groups : null);
    if (!oidcGroups) {
      console.error("wecom-oidc-callback: groups claim missing, login denied (C2)");
      return json({ error: "group_claim_missing_login_denied" }, 503);
    }

    // ② get-all-objects 可达对象（F11）
    // 不能直传 sub：该 API 要求 owner/name 双段，sub 是裸 user.Id → wrong token count → data=null → 503
    const casdoorUserId = tokenPayload.owner && tokenPayload.name
      ? `${tokenPayload.owner}/${tokenPayload.name}`
      : tokenPayload.sub;
    const reachable = await fetchAllObjects(issuer, accessToken, casdoorUserId);

    // ③ 门店范围展开（2026-08-18 范围资源唯一真相，fail-close）：
    //    门店范围只从 范围|X 资源读取（expandScopeResources）；无范围资源 → branch_nums: [] →
    //    B1 空集 deny（堵「漏配即放行」）。企微组织架构（部门组→maps）推导已废除。
    //    expand ok:false（未知范围键）仍由 buildClaims 判 C2 → 登录 503（不变）。
    const branchKeys = (reachable ?? [])
      .map((k) => normalizeFriendlyPerm(k))
      .filter((k) => typeof k === "string" && k.startsWith("data-analysis:branch:"))
      .map((k) => k.slice("data-analysis:branch:".length));
    const expandResult = branchKeys.length > 0
      ? await expandScopeResources(branchKeys, pgrstUrl)
      : { branch_nums: [], ok: true };   // 无范围资源 = authorized ∅（B1 deny）
    console.log("wecom-oidc-callback: scope source = permission-resources",
      { keys: branchKeys.length, ok: expandResult.ok === true });

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
        roles: casdoorRoles,           // Task 13: Casdoor 角色码（string[]）
      },
    });
    if (!claims) {
      // C2：三段任一失败（groups 空 / reachable 拉取失败 / 展开 ok:false）→ 登录整体失败
      console.error("wecom-oidc-callback: group scope unavailable, login denied",
        { expandError: expandResult?.error ?? null, reachable: Array.isArray(reachable) ? reachable.length : null });
      return json({ error: "group scope unavailable, login denied" }, 503);
    }

    // 5b. 写穿 org_users.groups 投影（F9，迁移 178）：无会话路径（run_push/agent-query）读门店行的
    //     唯一入口。best-effort（失败记日志不阻断登录——漂移由 Task 10/15 对账收口，与 role_codes 镜像同款语义）。
    try {
      await client.database.from("org_users").update({
        groups: oidcGroups,
      }).eq("wecom_id", wecomUserId);
    } catch (e) { console.error("groups projection mirror write failed", e); }

    // 5c. 签 PostgREST JWT：payload = buildClaims 产物（permissions=资源串 B2；groups/data_scope/fields/
    //     catalog_v 新四段；顶层旧四维 key 镜像已摘——W6/Task 20，双氧期结束）+ 注册项（sub/role/iss/iat/exp）。
    //     iss 区分来源；RLS 以 data_scope 段存在性鉴别（迁移 179；旧形状令牌 deny，185 终版）。
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwt({
      sub: wecomUserId,
      role: "authenticated",
      ...claims,
      iss: "casdoor-oidc",
      iat: now,
      exp: now + 7 * 86400,
    }, Deno.env.get("JWT_SECRET"));

    return json({ ok: true, wecom_userid: wecomUserId, wecom_name: userName, access_token: jwt });
  } catch (e) {
    // 脱敏：异常细节只留日志（防泄露环境/内部结构），客户端只拿通用错误。
    console.error("wecom-oidc-callback error:", e);
    return json({ error: "internal_error" }, 500);
  }
};
