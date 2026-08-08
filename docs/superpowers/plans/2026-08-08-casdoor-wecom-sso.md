# 企微统一身份 SSO(Casdoor 基石)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 data-analysis 仓内部署 Casdoor 作企微统一身份 IdP,把 data-analysis 登录迁移到 Casdoor(OIDC),身份/权限分层,PostgREST RLS 零改动。

**Architecture:** Casdoor(独立子域名 `sso.shanhaiyiguo.com`,sqlite)配 WeCom Internal provider 接 App A;data-analysis 作 Casdoor 的 OIDC client,登录后拿 `wecom_id` 自查 perms、自签 PostgREST JWT(业务 claims 不变)。身份层归 Casdoor,数据权限层留 data-analysis。

**Tech Stack:** Casdoor(Go,官方镜像)、Docker Compose、nginx-certbot、Deno Edge Function(InsForge)、Next.js 15、PostgREST、PostgreSQL RLS。

## Global Constraints

- **所有改动在 data-analysis 仓内**;WeKnora 不碰(后续轮次接入)。
- **PostgREST / RLS / `JWT_SECRET` / 权限表零改动** —— 身份/权限分层铁律。
- 企微 corp_id = `ww8252c1eee248867c`;App A agent_id = `1000008`;服务器出口 IP `113.249.120.84`。
- 「鉴权方案变更属架构变更」(`CLAUDE.md`)—— Task 12 必须更新 `docs/architecture.md`。
- 现有部署规矩:只改 `functions/*/index.js` → SSH 直调 InsForge API 部署 + 清 Deno 缓存(不走 GHA);改 `web/`/`deploy/`/`database/` → push 触发 GHA。
- 新 edge function 单文件(Deno,CommonJS,60s 超时),用 `Deno.env.get` 读 function secret,无法 `require` 共享模块。
- `JWT_SECRET` 已是 deno 容器 env(`deploy/docker-compose.yml` line 118)—— 签 PostgREST JWT 复用它。

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `deploy/docker-compose.yml` | Modify | 加 `casdoor` 服务 |
| `deploy/casdoor/conf/app.conf` | Create | Casdoor 配置(sqlite + origin) |
| `deploy/docker-compose.prod.yml` | Modify | nginx 加 `sso.shanhaiyiguo.com` server block |
| `functions/wecom-oidc-callback/index.js` | Create | Casdoor code → PostgREST JWT |
| `functions/wecom-oauth/index.js` | Modify | 登录职责退役,保留 `signJwt`(被 agent-query 复用) |
| `web/lib/wecom.ts` | Modify | 加 `exchangeCasdoorCode`;保留扫码直连作 fallback |
| `web/app/auth/callback/route.ts` | Modify | 收 Casdoor code → 调新 function → 写 cookie |
| `web/middleware.ts` | Modify | 未登录跳 Casdoor `/login/oauth/authorize` |
| `web/app/login/page.tsx` | Modify | 跳 Casdoor(替代直连企微) |
| `deploy/.env.example` | Modify | 加 Casdoor 相关变量 |
| `docs/architecture.md` | Modify | §1/§6/§7/§9 更新(Task 12) |
| `scripts/deploy-functions.sh` | Modify | 注入新 function 的 Casdoor secrets |

---

## Task 1: 前置外部依赖清单(DNS + 企微可信域名)

**Files:** 无代码(运维/人工操作,本 task 是检查清单)

**Interfaces:** Consumes 企微后台访问权 + DNS 管理权;Produces 公网 `sso.shanhaiyiguo.com` 可达 + App A 可信域名含 `sso.shanhaiyiguo.com`(Task 5 端到端验证依赖)。

- [ ] **Step 1: DNS A 记录**

在 `shanhaiyiguo.com` DNS 管理,加:
```
A  sso.shanhaiyiguo.com  →  113.249.120.84  (TTL 600)
```
验证:`dig +short sso.shanhaiyiguo.com` 应返回 `113.249.120.84`。

- [ ] **Step 2: 企微后台 App A 可信域名**

登录企业微信管理后台 → 应用管理 → App A(报表应用,Agent 1000008)→ 「网页授权及 JS-SDK」→「可信域名」加 `sso.shanhaiyiguo.com`(Casdoor 的 WeCom redirect 落点)。同时确认「企业可信 IP」已含 `113.249.120.84`(architecture §7.1,App A 早配过,复核)。

- [ ] **Step 3: 记录 App A 凭证**

确认可取到(后续 Casdoor provider 配置用):
- `WECOM_CORP_ID` = `ww8252c1eee248867c`
- `WECOM_AGENT_ID` = `1000008`
- `WECOM_SECRET` = App A secret(已在 deploy/.env 的 function secret)

- [ ] **Step 4: 在本 task 完成前不阻塞 Task 2-4**

DNS 和企微配置可与 Task 2-4 并行。但 **Task 5 端到端验证必须等本 task 完成**。

---

## Task 2: Casdoor 容器部署(sqlite,本地起)

**Files:**
- Modify: `deploy/docker-compose.yml`(加 `casdoor` 服务)
- Create: `deploy/casdoor/conf/app.conf`
- Create: `deploy/casdoor/init_data.json`(空,占位避免 Casdoor 报缺文件)

**Interfaces:** Consumes `insforge-network`;Produces `http://casdoor:8000`(容器内)+ `https://sso.shanhaiyiguo.com`(经 nginx,Task 3)。

- [ ] **Step 1: 写 Casdoor app.conf(sqlite)**

Create `deploy/casdoor/conf/app.conf`:
```ini
appname = casdoor
httpport = 8000
runmode = prod
copyrequestbody = true
driverName = sqlite3
dataSourceName = file:/data/casdoor.db?cache=shared&_busy_timeout=5000
dbName = casdoor
tableNamePrefix =
showSql = false
redisEndpoint =
origin = https://sso.shanhaiyiguo.com
originFrontend = https://sso.shanhaiyiguo.com
staticBaseUrl = "https://cdn.casbin.org"
isDemoMode = false
batchSize = 100
defaultLanguage = "zh"
quota = {"organization": -1, "user": -1, "application": -1, "provider": -1}
logConfig = {"adapter":"file", "filename": "logs/casdoor.log", "maxdays":99999, "perm":"0770"}
initDataNewOnly = false
initDataFile = "./init_data.json"
```

- [ ] **Step 2: 占位 init_data.json**

Create `deploy/casdoor/init_data.json`:
```json
{}
```

- [ ] **Step 3: 加 casdoor 服务到 docker-compose.yml**

在 `deploy/docker-compose.yml` 的 `services:` 下(`duckdb` 之后)加:
```yaml
  casdoor:
    image: casbin/casdoor:latest
    restart: unless-stopped
    entrypoint: /bin/sh -c './server --createDatabase=true'
    environment:
      RUNNING_IN_DOCKER: "true"
    volumes:
      - ./casdoor/conf:/conf:ro
      - casdoor-data:/data
      - casdoor-logs:/logs
    networks:
      - insforge-network
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:8000/api/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
```

在文件底部 `volumes:` 段加:
```yaml
  casdoor-data:
  casdoor-logs:
```

- [ ] **Step 4: 本地起 Casdoor,验证健康**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis/deploy
docker compose up -d casdoor
docker compose logs casdoor --tail 50
```
验证:`docker compose ps casdoor` 状态 healthy;日志无 `driver sqlite3 not found` / panic。

- [ ] **Step 5: sqlite 不支持则 fallback mysql**

若 Step 4 日志报 sqlite 驱动缺失(官方镜像可能未编入),切 mysql(spec §10 风险2 已授权 fallback):
- 改 `app.conf`:`driverName = mysql`,`dataSourceName = casdoor:caspwd@tcp(casdoor-db:3306)/`
- docker-compose.yml 加 `casdoor-db` 服务(镜像 `mysql:8.0`,`MYSQL_ROOT_PASSWORD=caspwd`,`casdoor-data` 换 mysql data 卷)
- 重跑 Step 4

- [ ] **Step 6: 验证 Casdoor API 可达(容器内)**

```bash
docker compose exec casdoor wget -qO- http://127.0.0.1:8000/api/health
```
Expected: 返回健康 JSON 或 HTTP 200。

- [ ] **Step 7: Commit**

```bash
git add deploy/docker-compose.yml deploy/casdoor/
git commit -m "feat(deploy): add Casdoor identity provider service (sqlite)"
```

---

## Task 3: nginx 反代 sso.shanhaiyiguo.com + 证书

**Files:** Modify: `deploy/docker-compose.prod.yml`(或其引用的 nginx 配置模板 `deploy/nginx/`)

**Interfaces:** Consumes `casdoor:8000`(Task 2);Produces `https://sso.shanhaiyiguo.com` 公网可达(Task 4-5 依赖)。

- [ ] **Step 1: 定位现有 nginx 配置**

```bash
ls /Users/duo/Documents/mytechcode/data-analysis/deploy/nginx/
grep -rn "server_name\|certbot\|data.shanhaiyiguo.com" deploy/docker-compose.prod.yml deploy/nginx/ 2>/dev/null
```
读出现有 `data.shanhaiyiguo.com` 的 server block 结构,照其模式加 sso。

- [ ] **Step 2: 加 sso server block**

在 nginx 配置里(与 data.shanhaiyiguo.com 同结构)新增:
```nginx
server {
    listen 80;
    server_name sso.shanhaiyiguo.com;
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl;
    server_name sso.shanhaiyiguo.com;

    # 证书由 certbot 管理(下一步申请)
    ssl_certificate     /etc/letsencrypt/live/sso.shanhaiyiguo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sso.shanhaiyiguo.com/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://casdoor:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- [ ] **Step 3: certbot 申请 sso 证书**

在 nginx 配置/脚本里把 `sso.shanhaiyiguo.com` 加入 certbot 申请域名列表(参照现有 `data.shanhaiyiguo.com` 的证书申请方式)。生产执行(部署时):
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com \
  "docker exec <nginx容器名> certbot certonly --webroot -w <webroot> -d sso.shanhaiyiguo.com --non-interactive --agree-tos -m <admin-email>"
```

- [ ] **Step 4: 验证公网反代**

部署 nginx 后(DNS Task 1 已生效):
```bash
curl -sI https://sso.shanhaiyiguo.com/api/health
```
Expected: HTTP 200 + Casdoor 响应头。

- [ ] **Step 5: Commit**

```bash
git add deploy/docker-compose.prod.yml deploy/nginx/
git commit -m "feat(deploy): nginx reverse proxy for sso.shanhaiyiguo.com -> casdoor"
```

---

## Task 4: Casdoor 配 WeCom Internal provider + application

**Files:** 无代码(Casdoor Web UI / API 配置;可用 Casdoor API 脚本化)

**Interfaces:** Consumes Task 1(企微凭证 + 可信域名)+ Task 3(公网可达);Produces Casdoor provider `wecom_silent` + application `data-analysis`(Task 7-9 消费 client_id/secret)。

- [ ] **Step 1: 登录 Casdoor 初始化**

浏览器开 `https://sso.shanhaiyiguo.com`,用初始管理员(built-in `admin`/`123`)登录,改密码。

- [ ] **Step 2: 配 WeCom provider**

Casdoor → Identity Providers → Add:
- Category: `OAuth`
- Type: `WeCom`
- Name: `wecom_silent`
- SubType: `Internal`
- Client ID: `ww8252c1eee248867c`(corp_id)
- Client Secret: App A 的 `WECOM_SECRET`
- App ID: `1000008`(agent_id)
- **Scope**: `snsapi_base`
- **Method**: `Silent`(企微内静默;实测见 spec §3.4,method 是 provider 级单值)
- **勾选「Use id as name」** —— 使 Casdoor username = 企微 userid,后续 userinfo.sub = wecom_id(wecom_internal.go:226)

- [ ] **Step 3: 验证 Casdoor 生成企微授权 URL**

Casdoor → 该 provider 的「Test」或登录页点 WeCom 入口,检查跳转 URL 应含:
```
open.weixin.qq.com/connect/oauth2/authorize?appid=ww8252c1eee248867c&agentid=1000008&scope=snsapi_base&...#wechat_redirect
```
(对应 spec §3 实测的 Silent 分支)。若 URL 不符,复核 Step 2 字段。

- [ ] **Step 4: 建 data-analysis OIDC application**

Casdoor → Applications → Add:
- Name: `data-analysis`
- Organization: `built-in`(或自建 org)
- Client ID / Client Secret:Casdoor 生成,**记下**(Task 8/9 用)
- Redirect URLs: `https://data.shanhaiyiguo.com/auth/callback`
- Token format: `JWT-Standard`
- Scopes: `openid profile`
- **Providers**: 勾选 `wecom_silent`
- **启用 Auto signin**(勾选 `wecom_silent`):跳过 Casdoor 登录页直接跳企微

- [ ] **Step 5: 记录 application 凭证**

把 Client ID / Client Secret 存为 function secret(Task 7 用,经 `scripts/deploy-functions.sh` 注入):
- `CASDOOR_ISSUER` = `https://sso.shanhaiyiguo.com`
- `CASDOOR_CLIENT_ID` = application Client ID
- `CASDOOR_CLIENT_SECRET` = application Client Secret

- [ ] **Step 6: Commit(配置记录)**

无代码改动则跳过 commit;若有 Casdoor 配置导出脚本则提交。

---

## Task 5: 端到端验证企微登录(需 Task 1 完成)

**Files:** 无。验证 task。

**Interfaces:** 验证 Task 4 provider 真能经企微拿 wecom_id。

- [ ] **Step 1: 企微客户端内触发登录**

在企微 App 内打开 Casdoor 登录链接(Casdoor → application `data-analysis` 的 signin URL,或直接 `https://sso.shanhaiyiguo.com/login/oauth/authorize?client_id=<da_client_id>&redirect_uri=https://data.shanhaiyiguo.com/auth/callback&response_type=code&scope=openid+profile&state=test`)。

- [ ] **Step 2: 确认回调拿到 code 并能在 Casdoor 看到 wecom 用户**

授权后 Casdoor 应回调 `data.shanhaiyiguo.com/auth/callback?code=...&state=test`(此时 data-analysis 还没接,先看 Casdoor 侧)。
Casdoor → Users:应看到新建用户,name = 企微 userid(如 `ZhangDuo`)。

- [ ] **Step 3: 失败排查清单**

- 回调报 `redirect_uri mismatch`:Task 4 Step 4 Redirect URL 没加 / 拼错。
- `60020 not allow to access`:App A 可信 IP 没加 `113.249.120.84`。
- `userid` 空:scope/method 配错,或非企微内环境触发(Silent 需企微客户端)。

- [ ] **Step 4: 验证 provider 预选(可选,为 Task 9 双模式铺路)**

测 `https://sso.shanhaiyiguo.com/login/oauth/authorize?...&provider=wecom_silent` 是否自动跳企微不经登录页。
- 支持 → Task 9 双模式用「一 application + 两 provider(Silent/Normal)+ middleware 按 UA 带 provider 参数」。
- 不支持 → fallback:Task 9 双模式用「两 application(da-mobile 绑 Silent / da-pc 绑 Normal)」。

---

## Task 6: （可选)双模式 Normal provider —— 仅当本轮要覆盖 PC 扫码

> spec §11 允许初版只配 Silent(企微内)。若本轮也要 PC 扫码经 Casdoor,做本 task;否则跳过,PC 扫码保留 `web/lib/wecom.ts` 的 `buildWecomQrLoginUrl` 直连现状。

**Files:** Casdoor 配置(无代码)。

- [ ] **Step 1: 加 wecom_scan provider**

Casdoor → Identity Providers → Add,同 Task 4 Step 2 但:
- Name: `wecom_scan`
- Method: `Normal`(PC 扫码,`wwlogin/sso/login`)
- 其余同(corp_id / secret / agent_id / Use id as name)

- [ ] **Step 2: 按 Task 5 Step 4 结论绑定到 application**

- 若 provider 预选支持:application `data-analysis` Providers 勾 `wecom_silent` + `wecom_scan`,Task 9 middleware 按 UA 带 `provider` 参数。
- 若不支持:建第二个 application `data-analysis-pc` 绑 `wecom_scan`,Redirect URL `https://data.shanhaiyiguo.com/auth/callback?src=pc`,Task 9 按 UA 跳不同 application。

---

## Task 7: 新增 edge function `wecom-oidc-callback`

**Files:**
- Create: `functions/wecom-oidc-callback/index.js`
- Modify: `scripts/deploy-functions.sh`(注入 Casdoor secrets)
- Test: 本地 dev InsForge + curl

**Interfaces:**
- Consumes: function secrets `CASDOOR_ISSUER` / `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` / `JWT_SECRET` / `ANON_KEY` / `INSFORGE_API_BASE` / `POSTGREST_URL`(Task 4 Step 5)
- Produces: `POST /functions/wecom-oidc-callback` body `{ code, redirect_uri }` → `{ ok, wecom_userid, wecom_name, access_token }`(Task 8 消费)

- [ ] **Step 1: 写 function 主逻辑**

Create `functions/wecom-oidc-callback/index.js`:
```javascript
// Casdoor OIDC authorization code → 换 token → userinfo(sub=wecom_id)
//   → upsert org_users + get_user_perms → 签 PostgREST JWT(role=authenticated)
// 复用 wecom-oauth 的 signJwt + claims 结构(JWT_SECRET / PostgREST RLS 不变)。
// 所需 secrets: CASDOOR_ISSUER / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / JWT_SECRET
//              ANON_KEY / INSFORGE_API_BASE / POSTGREST_URL

// ---- signJwt(从 wecom-oauth 复制;edge function 单文件无法 require 共享)----
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
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

module.exports = async function (req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
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

    // 3. upsert org_users + 查部门(与 wecom-oauth 同款)
    const { createClient } = await import("https://esm.sh/@insforge/sdk@0.0.38");
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });
    await client.database.from("org_users").upsert(
      { wecom_id: wecomUserId }, { onConflict: "wecom_id" },
    );
    const { data: user } = await client.database
      .from("org_users").select("department_ids, name")
      .eq("wecom_id", wecomUserId).single();
    const departmentIds = user?.department_ids || [];
    const userName = user?.name || wecomUserId;

    // 4. get_user_perms(复用 wecom-oauth 同款直连 postgrest)
    const pgrstUrl = Deno.env.get("POSTGREST_URL") || "http://postgrest:3000";
    let perms = {};
    try {
      const permRes = await fetch(`${pgrstUrl}/rpc/get_user_perms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_wecom_id: wecomUserId }),
      });
      if (permRes.ok) perms = await permRes.json() || {};
    } catch (e) { console.error("get_user_perms failed", e); }

    // 5. 签 PostgREST JWT(claims 与 wecom-oauth 完全一致 → RLS 不变)
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
```

> **注意 SDK import**:`wecom-oauth` 用 `createClient` 但没显式 import(可能 InsForge deno runtime 预注入)。若 runtime 报 `createClient is not defined`,加顶部 `const { createClient } = await import("https://esm.sh/@insforge/sdk@0.0.38")`(如上已写)。部署后看 deno 日志确认。

- [ ] **Step 2: deploy-functions.sh 注入 Casdoor secrets**

Modify `scripts/deploy-functions.sh`,在 secrets 注入段加(Task 4 Step 5 的值):
```bash
set_secret CASDOOR_ISSUER "https://sso.shanhaiyiguo.com"
set_secret CASDOOR_CLIENT_ID "<Task4 记的 Client ID>"
set_secret CASDOOR_CLIENT_SECRET "<Task4 记的 Client Secret>"
```
并在 function 部署列表加 `wecom-oidc-callback`。

- [ ] **Step 3: 部署到本地 dev InsForge**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis
bash scripts/deploy-functions.sh   # 注入 secrets + 部署 function
# 清 Deno 缓存
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno" 2>/dev/null || true
```
(本地 dev 则 `docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno`)

- [ ] **Step 4: curl 测 function(用 Task 5 拿到的真 code)**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-oidc-callback \
  -H "Content-Type: application/json" \
  -d '{"code":"<Task5的真Casdoor code>","redirect_uri":"https://data.shanhaiyiguo.com/auth/callback"}'
```
Expected: `{"ok":true,"wecom_userid":"<企微userid>","wecom_name":"<名>","access_token":"<JWT>"}`。

- [ ] **Step 5: 验证签出的 JWT 能过 PostgREST**

```bash
JWT="<Step4 返回的 access_token>"
curl -s "https://data.shanhaiyiguo.com/rest/v1/org_users?select=wecom_id,name&limit=1" \
  -H "Authorization: Bearer $JWT"
```
Expected: 200 + 数据(证明 JWT_SECRET 验签 + RLS 通过)。

- [ ] **Step 6: Commit**

```bash
git add functions/wecom-oidc-callback/index.js scripts/deploy-functions.sh
git commit -m "feat(functions): add wecom-oidc-callback (Casdoor code -> PostgREST JWT)"
```

---

## Task 8: web 端接 Casdoor callback + lib

**Files:**
- Modify: `web/lib/wecom.ts`(加 `exchangeCasdoorCode`)
- Modify: `web/app/auth/callback/route.ts`(收 Casdoor code)
- Modify: `web/.env`(加 `NEXT_PUBLIC_CASDOOR_*`)

**Interfaces:**
- Consumes: Task 7 function;Casdoor application(Task 4)
- Produces: cookie `insforge_access_token`(PostgREST JWT,现状不变)→ middleware 放行

- [ ] **Step 1: web/.env 加 Casdoor 公开变量**

`web/.env`(及 prod web 容器 env):
```bash
NEXT_PUBLIC_CASDOOR_ISSUER=https://sso.shanhaiyiguo.com
NEXT_PUBLIC_CASDOOR_CLIENT_ID=<Task4 Client ID>
NEXT_PUBLIC_CASDOOR_REDIRECT_URI=https://data.shanhaiyiguo.com/auth/callback
```

- [ ] **Step 2: lib/wecom.ts 加 exchangeCasdoorCode**

在 `web/lib/wecom.ts` 末尾加(保留现有 `buildWecomQrLoginUrl` 作 PC 扫码 fallback,见 Task 6 备注):
```typescript
// 调 wecom-oidc-callback function:Casdoor authorization code → PostgREST JWT
export async function exchangeCasdoorCode(code: string, redirectUri: string) {
  const { data, error } = await insforge.functions.invoke("wecom-oidc-callback", {
    method: "POST",
    body: { code, redirect_uri: redirectUri },
  });
  return { data, error };
}

// 构造 Casdoor OIDC authorize URL(企微内 Silent;PC 经 Casdoor扫码见 Task 9)
export function buildCasdoorAuthUrl(redirectUri: string, state: string, provider?: string): string {
  const issuer = process.env.NEXT_PUBLIC_CASDOOR_ISSUER;
  const clientId = process.env.NEXT_PUBLIC_CASDOOR_CLIENT_ID;
  if (!issuer || !clientId) return "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile",
    state,
  });
  if (provider) params.set("provider", provider); // Task 5 Step 4 验证支持则用
  return `${issuer}/login/oauth/authorize?${params.toString()}`;
}
```

- [ ] **Step 3: 改 auth/callback/route.ts 收 Casdoor code**

Modify `web/app/auth/callback/route.ts`,把 `exchangeWecomCode` 换成 `exchangeCasdoorCode`(cookie 写法不变):
```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeCasdoorCode } from "@/lib/wecom";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "/";
  const targetPath = decodeURIComponent(state);
  const safeTarget = targetPath.startsWith("/") ? targetPath : "/";

  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;
  const redirectUri = process.env.NEXT_PUBLIC_CASDOOR_REDIRECT_URI || `${origin}/auth/callback`;
  const login = (err: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, origin));

  if (!code) return login("missing_code");

  const { data, error } = await exchangeCasdoorCode(code, redirectUri);
  if (error || !data?.ok || !data.access_token) {
    return login(String((data as any)?.error ?? error ?? "exchange_failed"));
  }

  const c = await cookies();
  const isHttps = proto === "https";
  c.set("insforge_access_token", data.access_token, {
    httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", maxAge: 7 * 86400,
  });
  c.set("wecom_userid", data.wecom_userid, {
    httpOnly: false, secure: isHttps, sameSite: "lax", path: "/", maxAge: 7 * 86400,
  });
  if (data.wecom_name) {
    c.set("wecom_name", data.wecom_name, {
      httpOnly: false, secure: isHttps, sameSite: "lax", path: "/", maxAge: 7 * 86400,
    });
  }
  return NextResponse.redirect(new URL(safeTarget, origin));
}
```

- [ ] **Step 4: 本地 type-check**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis/web && npm run type-check
```
Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add web/lib/wecom.ts web/app/auth/callback/route.ts web/.env
git commit -m "feat(web): wire Casdoor OIDC callback -> PostgREST JWT cookie"
```

---

## Task 9: middleware + login 跳 Casdoor

**Files:**
- Modify: `web/middleware.ts`
- Modify: `web/app/login/page.tsx`

**Interfaces:** Consumes Task 8 `buildCasdoorAuthUrl`;Produces 未登录用户被重定向到 Casdoor `/login/oauth/authorize`。

- [ ] **Step 1: middleware 未登录跳 Casdoor**

Modify `web/middleware.ts`:
- `handleWecomClient`:无 token 时改跳 Casdoor(替代 `buildWecomAuthUrl` 直连企微)
- `handleRegularBrowser`:无 token 时改跳 Casdoor(替代跳 /login)

把两个 handler 里"构造企微授权 URL 并 307"的逻辑,替换为构造 Casdoor URL:

```typescript
import { buildCasdoorAuthUrl } from "@/lib/wecom";

// 在 handleWecomClient 与 handleRegularBrowser 中,无 token 分支统一:
function redirectToCasdoor(req: NextRequest, targetPath: string): NextResponse {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;
  const redirectUri = process.env.NEXT_PUBLIC_CASDOOR_REDIRECT_URI || `${origin}/auth/callback`;
  const issuer = process.env.NEXT_PUBLIC_CASDOOR_ISSUER;
  const clientId = process.env.NEXT_PUBLIC_CASDOOR_CLIENT_ID;
  if (!issuer || !clientId) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", targetPath);
    return NextResponse.redirect(url);
  }
  // 企微客户端走 Silent;PC 走 Normal(需 Task 6 配 wecom_scan + Task5 Step4 provider 预选支持)
  const ua = req.headers.get("user-agent")?.toLowerCase() || "";
  const provider = ua.includes("wxwork") ? "wecom_silent" : "wecom_scan"; // 若 Task6 未做,PC 暂用 wecom_silent 或保留 /login 扫码
  const authUrl = buildCasdoorAuthUrl(redirectUri, encodeURIComponent(targetPath), provider);
  return NextResponse.redirect(authUrl, 307);
}
```
在 `handleWecomClient` 无 token 处:`return redirectToCasdoor(req, targetPath);`
在 `handleRegularBrowser` 无 token 处:同样 `return redirectToCasdoor(req, req.nextUrl.pathname + req.nextUrl.search);`
(删掉 middleware 内本地 `buildWecomAuthUrl` 副本,改 import `buildCasdoorAuthUrl`)

- [ ] **Step 2: login 页改为跳 Casdoor(兜底)**

Modify `web/app/login/page.tsx`:当 middleware 兜底到 /login 时(Casdoor 未配置),显示按钮跳 Casdoor。把 `buildWecomAuthUrl`/`buildWecomQrLoginUrl` 按钮替换为 Casdoor authorize 链接:
```typescript
import { buildCasdoorAuthUrl } from "@/lib/wecom";
// ...
const casdoorUrl = buildCasdoorAuthUrl(redirectUri, encodeURIComponent(safeNext));
// 按钮 href={casdoorUrl},文案"使用企业微信登录"
```
(保留 `buildWecomQrLoginUrl` 直连扫码作 PC fallback,仅当 Task 6 未做时显示)

- [ ] **Step 3: type-check**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis/web && npm run type-check
```

- [ ] **Step 4: Commit**

```bash
git add web/middleware.ts web/app/login/page.tsx
git commit -m "feat(web): redirect unauthenticated users to Casdoor OIDC"
```

---

## Task 10: wecom-oauth 退役 + 保留 signJwt

**Files:** Modify: `functions/wecom-oauth/index.js`

**Interfaces:** Consumes 现 agent-query 网关对 `signJwt` 的复用(spec §4.2);Produces wecom-oauth 不再服务登录,但 signJwt 能力保留。

- [ ] **Step 1: 确认 agent-query 对 signJwt 的依赖**

```bash
grep -rn "signJwt\|require.*wecom-oauth\|from.*wecom-oauth" /Users/duo/Documents/mytechcode/data-analysis/functions/
```
确认 `agent-query`(或其它)是否 import wecom-oauth 的 signJwt。edge function 单文件无法互相 require,所以 signJwt 多半是**各自复制**的副本(如 Task 7 也复制了一份)。

- [ ] **Step 2: 决策**

- 若 signJwt 是各 function 复制副本(无跨 function 引用)→ wecom-oauth 可整体保留(不删,只是登录不再被 web 调用),零风险。
- 若有引用 → 提取 signJwt 到被引用处复制(保持单文件原则),再退役 wecom-oauth 登录入口。

- [ ] **Step 3: web 端不再调 wecom-oauth(Task 8 已切)**

确认 `exchangeWecomCode` 在 web 已无调用(grep)。若 PC 扫码 fallback 仍用 `buildWecomQrLoginUrl` + `wecom-oauth`,则 wecom-oauth **保留**(服务 PC 扫码直连路径)。

- [ ] **Step 4: Commit(若有改动)**

```bash
git add functions/wecom-oauth/index.js
git commit -m "chore(functions): retire wecom-oauth login path (keep signJwt for agent-query)"
```

---

## Task 11: RLS 回归 + SSO 验证

**Files:** 无。验证 task。

- [ ] **Step 1: RLS 行级回归(关键)**

用两个不同部门/权限的企微账号分别登录,各查同一报表:
- 账号 A(全权 `branch_nums=["*"]`)应见全部门店。
- 账号 B(受限 `branch_nums=["54","127"]`)只见 2 店。
证明身份迁 Casdoor 后,数据权限(RLS by PostgREST JWT claims)未被破坏。

- [ ] **Step 2: RLS 列级回归**

`can_see_cost=false` 的账号,成本/利润列应为 NULL(脱敏),不可被反算。

- [ ] **Step 3: SSO 验证**

- 企微内登 data-analysis 成功 → 浏览器开 Casdoor `sso.shanhaiyiguo.com` 应已登录态(不再要求登录)= Casdoor 会话已建。
- (后续接 WeKnora 时验证)访问第二个 Casdoor client 应免再授权。

- [ ] **Step 4: 登出回归**

`POST /api/auth/logout` 仍清本地 cookie + 写 blacklist(现状不变)。验证登出后访问受保护页跳 Casdoor。

---

## Task 12: 更新架构文档 + .env.example

**Files:**
- Modify: `docs/architecture.md`(§1/§6/§7/§9)
- Modify: `deploy/.env.example`

- [ ] **Step 1: architecture.md §1 系统总览**

在系统总览图核心服务层加 `casdoor(8000) → 统一身份 IdP(SSO)`;外部服务「企业微信·OAuth → 用户登录」改为「→ Casdoor(WeCom provider)」。

- [ ] **Step 2: architecture.md §6 鉴权系统**

改写 §6.1 登录流程:身份层经 Casdoor(企微 OAuth upstream)→ data-analysis callback 拿 wecom_id 自查 perms 自签 PostgREST JWT(数据权限层不变)。明确「身份/权限分层」原则。

- [ ] **Step 3: architecture.md §7.1 企微三应用**

App A 标注「登录凭证迁 Casdoor WeCom provider」;App B/C 不变。

- [ ] **Step 4: architecture.md §9 已确认架构决策**

加:
```
| 统一身份 IdP | Casdoor(独立子域名,sqlite,WeCom Internal provider) | 2026-08-08 |
| 身份/权限分层 | Casdoor 管身份;data-analysis 自签 PostgREST JWT 管数据权限(RLS 不变) | 2026-08-08 |
```

- [ ] **Step 5: deploy/.env.example**

加 Casdoor 段:
```bash
# ============ Casdoor(统一身份 IdP)============
# Casdoor 容器配置
CASDOOR_ORIGIN=https://sso.shanhaiyiguo.com
# function secrets(由 deploy-functions.sh 注入)
CASDOOR_ISSUER=https://sso.shanhaiyiguo.com
CASDOOR_CLIENT_ID=
CASDOOR_CLIENT_SECRET=
# web 公开变量
NEXT_PUBLIC_CASDOOR_ISSUER=https://sso.shanhaiyiguo.com
NEXT_PUBLIC_CASDOOR_CLIENT_ID=
NEXT_PUBLIC_CASDOOR_REDIRECT_URI=https://data.shanhaiyiguo.com/auth/callback
```

- [ ] **Step 6: Commit + 回填 spec §3.5**

```bash
git add docs/architecture.md deploy/.env.example
git commit -m "docs: reflect Casdoor unified-identity SSO in architecture + env"
```
回填 spec `2026-08-08-casdoor-wecom-sso-design.md` §3.5 端到端实测结果(Task 5 结论)。

---

## Self-Review

**1. Spec coverage:**
- §5 组件清单 → Task 2-10 逐项覆盖 ✓
- §3 实测双模式 → Task 4(Silent)+ Task 6(Normal 可选)✓
- §6 数据流 → Task 7-9 ✓
- §7 provider 配置 → Task 4 ✓
- §9 测试 → Task 5/11 ✓
- §10 风险(sqlite)→ Task 2 Step 5 fallback ✓;wecom-oauth 退役 → Task 10 ✓
- §13 文档更新 → Task 12 ✓

**2. Placeholder scan:** 无 TBD/TODO。Task 4/6 的凭证值标注「Task 4 Step 5 记下」是引用上游 task 产物,非占位。Casdoor SDK import 注了 runtime 确认步骤(Step 1 备注)。

**3. Type consistency:** `exchangeCasdoorCode(code, redirectUri)` 在 Task 7(produces)、Task 8(consumes)签名一致;`buildCasdoorAuthUrl(redirectUri, state, provider?)` 在 Task 8(defines)、Task 9(uses)一致;cookie 名 `insforge_access_token` 全链路一致。
