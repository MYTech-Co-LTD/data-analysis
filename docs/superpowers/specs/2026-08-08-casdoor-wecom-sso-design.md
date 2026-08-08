# 企微统一身份 SSO(Casdoor 基石)设计

> 状态:已通过 Casdoor 源码实测验证核心可行性 · 2026-08-08
> 类型:**架构变更(鉴权方案)** —— 按 `CLAUDE.md` 规则,实施前需更新 `docs/architecture.md`(§6 鉴权 + §7 企微 + 系统总览新增 Casdoor 节点)。
> 范围:**先基石** —— Casdoor 部署 + 企微 provider + data-analysis 迁移。WeKnora 接入作为第一个外部 OIDC client 留到下一轮。

---

## 1. 背景与目标

### 1.1 背景
多套系统各自维护登录,身份不统一:
- **data-analysis**:企微 OAuth(`snsapi_base`)直连,edge function `wecom-oauth` 自签 HS256 JWT,PostgREST 验签。
- **WeKnora**(外部知识库项目):企微仅作 **IM 消息渠道**(收发问答),登录走 JWT 账号密码 / OIDC 客户端,与企微无关。
- 未来还将接入更多系统。

### 1.2 目标
以**企业微信为统一身份源**,实现:
1. **企微内 SSO** —— 用户在企微内登录一次,跨系统免再授权。
2. **低成本扩展** —— 后续每接一个系统,只在统一 IdP 注册一个 client,不重复对接企微 API。
3. **不破坏现有数据权限** —— data-analysis 的 PostgREST RLS 行级/列级权限零改动。

### 1.3 非目标(YAGNI)
- 全 SSO 登出(一处登出全系统登出)—— 各系统登出仍只清本地 cookie,后续再议。
- token 级跨系统互认(一个 JWT 两边认)—— 已判定不可行(claims 模型不同),不做。

---

## 2. 现状与关键约束

### 2.1 data-analysis 的鉴权是两层叠加(硬约束)
| 层 | 内容 | 实现 |
|----|------|------|
| **身份层** | 这个人是谁(`wecom_id`)、能否登录 | 企微 OAuth(App A)→ `functions/wecom-oauth` |
| **数据权限层** | 能看哪些门店/部门/成本(`departments`、`branch_nums`、`can_see_cost`) | PostgREST JWT claims → PostgreSQL **RLS** |

**硬约束**:PostgREST 用 `PGRST_JWT_SECRET`(=`JWT_SECRET`,HS256)验签,且 RLS 策略直接读 JWT 业务 claim:
- `WHERE departments ?| current_setting('request.jwt.claims.departments')`
- `request.jwt.claims.branch_nums` / `request.jwt.claims.can_see_cost`(由 `pgrst_pre_request` 扁平化为 GUC)

这些是 data-analysis 特有的细粒度数据权限,**不是标准身份字段**,塞不进任何标准 IdP 的 token。

**推论**:身份层可统一到 IdP;数据权限层必须保留在 data-analysis 自签的 JWT 里。→ **身份/权限分层**是本设计的核心原则。

### 2.2 企微三应用拓扑(architecture §7.1,corp `ww8252c1eee248867c`)
| 应用 | 用途 | 本设计处理 |
|------|------|-----------|
| **App A · 报表应用**(Agent 1000008) | OAuth 登录 + 报表软门禁 | **登录凭证挪到 Casdoor 的 WeCom provider** |
| App B · 同步/通知应用 | 通讯录同步 + 统一通知 | **不动**(非身份入口) |
| App C · OpenClaw bot | OpenClaw 对话 channel | **不动**(非身份入口) |

### 2.3 WeKnora 鉴权(确认与企微无关)
- JWT 账号密码登录(HS256 + `JWT_SECRET`,且 token 必须在 `auth_tokens` 表有未撤销记录,外部签不出来)。
- 原生支持 **OIDC 客户端**,且环境变量支持**显式配置各端点**(`OIDC_AUTH_AUTHORIZATION_ENDPOINT / TOKEN_ENDPOINT / USER_INFO_ENDPOINT`),不强制 discovery → **可对接任何符合 OIDC 的 provider,0 源码改动**。

---

## 3. 实测结论:Casdoor 对企业微信开箱即用

已读 Casdoor 源码(`/tmp/casdoor`,main 分支)确定性地验证(非假设):

### 3.1 WeCom Internal provider 完整支持双模式
`web/src/auth/Provider.js:509-519` 的 `getAuthUrl` 对 `WeCom / Internal` 有专门分支:
- **Silent(企微内静默)** → `open.weixin.qq.com/connect/oauth2/authorize?appid={corp}&agentid={agent}&scope=snsapi_..&response_type=code&state=..#wechat_redirect`
- **Normal(PC 扫码)** → `login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid={corp}&agentid={agent}&redirect_uri=..&state=..`

`web/src/auth/Provider.js:101-106`:
```js
WeCom: {
  scope: "snsapi_userinfo",
  endpoint:           "https://login.work.weixin.qq.com/wwlogin/sso/login",
  silentEndpoint:     "https://open.weixin.qq.com/connect/oauth2/authorize",
  internalEndpoint:   "https://login.work.weixin.qq.com/wwlogin/sso/login",
}
```

### 3.2 风险澄清
| 原担忧 | 实测结果 |
|--------|---------|
| 扫码端点废弃(`qrConnect`) | ❌ 不成立 —— Casdoor **已用新端点** `wwlogin/sso/login` |
| 双模式不支持 | ❌ 不成立 —— Silent + Normal 完整支持,参数合规(`appid`/`agentid`/`#wechat_redirect`) |

### 3.3 后端取用户(与 data-analysis 同款 API)
`idp/wecom_internal.go`:GetToken 用 `qyapi.weixin.qq.com/cgi-bin/gettoken`;GetUserInfo 用 `qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?code=` —— 与 `functions/wecom-oauth/index.js` 用的是**同一套企微 API**,App A 凭证可直接复用。回调处理见 `web/src/auth/AuthCallback.js:239`(WeCom 专门分支)。

### 3.4 唯一配置小点(非阻塞)
`method`(Silent/Normal)是 **provider 级单值**。要"企微内静默 + PC 扫码"同时支持,配两个 WeCom provider(都指向 App A,一 Silent 一 Normal),登录页按 User-Agent 自动跳转对应那个。

### 3.5 端到端实测边界
代码层实测已**确定性地**确认方案成立。真正"跳企微拿 userid"的端到端联通,需公网 `sso` 域名 + 企微后台可信域名配置 → 属于**部署后验证**(部署 Casdoor 上线后验),不阻塞设计定稿。

---

## 4. 目标架构(身份/权限分层)

```
                       ┌──────────────────────────────────────┐
   企业微信 App A ────► │  Casdoor  (sso.shanhaiyiguo.com)       │  sqlite · WeCom Internal provider
   (登录凭证挪过来)      │  统一身份 + SSO 会话                   │
                       └─────────────────┬────────────────────┘
                                         │ 标准 OIDC(authorization code)
                  ┌──────────────────────┼──────────────────────┐
                  ▼                                              ▼
        data-analysis(本轮迁移)                          WeKnora / 未来系统(后续接入)
        Casdoor token(sub=wecom_id)                    只配 OIDC env,0 源码改
        → 查本地 org_users + get_user_perms
        → 自签 PostgREST JWT(业务 claims 不变)
        → PostgREST 验 JWT_SECRET(不变)→ RLS(不变)
```

**身份/权限分层**:Casdoor 只统一"身份 + SSO 会话";data-analysis 拿到 `wecom_id` 后自查数据权限并自签 PostgREST JWT。→ **PostgREST、RLS、`JWT_SECRET`、权限表全部零改动**。

---

## 5. 组件改动清单(全部在 data-analysis 仓)

| 组件 | 改动 | 备注 |
|------|------|------|
| **Casdoor 容器** | `deploy/docker-compose.yml` 加 `casdoor` 服务,sqlite 卷,接入 `insforge-network` | 官方镜像 `casbin/casdoor` |
| **nginx** | 现有 prod nginx 加 `sso.shanhaiyiguo.com` server block;certbot 加证书;`location / → casdoor:8000` | 复用现有 nginx-certbot |
| **DNS** | `sso.shanhaiyiguo.com` A 记录指向服务器 `113.249.120.84` | 企微可信域名也要加这个 |
| **企微后台(App A)** | 「网页授权及 JS-SDK / 可信域名」加 `sso.shanhaiyiguo.com`(Casdoor 的 OAuth redirect 落点) | App A 的「企业可信 IP」已配服务器出口 IP(§7.1),无需重配 |
| **Casdoor 配置** | 建 WeCom Internal provider(见 §7);建 2 个 OIDC application:① `data-analysis`(本轮)② 预留(后续 WeKnora) | |
| **edge function** | 新增 `functions/wecom-oidc-callback`:输入 Casdoor authorization code → 换 Casdoor token → `/userinfo` 拿 `wecom_id` → 查本地 perms → **复用现有 `signJwt` + `JWT_SECRET` 签 PostgREST JWT** | 取代 `wecom-oauth` 的登录职责 |
| **web 登录链路** | `login` / `middleware` 跳转目标改 Casdoor `/authorize`;`web/app/auth/callback/route.ts` 改收 Casdoor code 并转发给新 function;`web/lib/wecom.ts` 的 `exchangeWecomCode → exchangeCasdoorCode`;cookie 写法不变 | |
| **`functions/wecom-oauth`** | 登录职责移除;但 `signJwt` 被 `agent-query` 网关复用(§4.2),**保留该能力**(提取为共享或保留文件) | 不能直接删 |
| **PostgREST / RLS / 权限表** | **零改动** | 分层设计保护 |

---

## 6. 登录数据流

```
访问 data.shanhaiyiguo.com
  → middleware 检查 insforge_access_token cookie,无 → 跳 Casdoor /authorize
        (client_id=data-analysis, redirect=data.shanhaiyiguo.com/auth/callback, scope=openid profile)
  → Casdoor 检查自身 SSO 会话:
      ├ 有会话 → 直接静默回调(不再碰企微)= SSO  ← 第二个系统接入后体现价值
      └ 无会话 → 跳企微(企微内 snsapi_base 静默 / PC 外扫码)→ Casdoor 建/更用户(wecom_id)→ 建 Casdoor 会话
  → Casdoor 回调 data.shanhaiyiguo.com/auth/callback?code=<casdoor code>
  → web 转发 → functions/wecom-oidc-callback:
        Casdoor code → /token → access_token/id_token → /userinfo(sub=wecom_id)
        → upsert org_users + 查 get_user_perms(branch_nums/can_see_cost 等)
        → 签 PostgREST JWT(现状 claims 结构,JWT_SECRET)
  → web 写 insforge_access_token(httpOnly) + wecom_userid + wecom_name cookie(现状不变)
  → 后续 PostgREST 请求:验 JWT_SECRET(不变)→ RLS(不变)
```

**SSO 体现**:用户首次登录建 Casdoor 会话;之后访问 WeKnora(或任何 Casdoor client)时,Casdoor 检测到已有会话 → 静默回调,不再跳企微。

---

## 7. Casdoor WeCom provider 配置规格

| Casdoor provider 字段 | 值 | 说明 |
|----------------------|-----|------|
| `type` | `WeCom` | |
| `subType` | `Internal` | 自建应用(对应 App A),非第三方套件 |
| `clientId` | `ww8252c1eee248867c` | 企业 corp_id |
| `appId` | `1000008` | App A agent_id(getAuthUrl 中映射为 `agentid`) |
| `clientSecret` | App A 的 `WECOM_SECRET` | |
| `method` | `Silent`(企微内)和/或 `Normal`(PC 扫码) | 见 §3.4 双 provider 方案 |
| `scope` | `snsapi_base`(最小)或 `snsapi_privateinfo` | |
| `redirectUri` | `https://sso.shanhaiyiguo.com/callback` | Casdoor 的 social callback |

Casdoor OIDC application(data-analysis client):
- `client_id` / `client_secret`:Casdoor 生成
- `redirect_uris`:`https://data.shanhaiyiguo.com/auth/callback`
- `scopes`:`openid profile`(只需身份,wecom_id 作 sub)

---

## 8. 错误处理 + 监控
- **Casdoor healthcheck**:接入现有 `monitor` 的 `service_down` 探活(architecture §8.1),Casdoor 不可达告警。
- **登录失败**:Casdoor token/userinfo 失败 → 回 `/login?error=<code>`(沿用现状 error 模式)。
- **perms 查询失败**:`perms={}` 兜底(现状已有),不阻断登录。
- **IdP 单点**:Casdoor 挂 = 登录不可用(所有依赖系统)。需纳入监控告警,部署需考虑可用性。

---

## 9. 测试策略
1. **Casdoor + 企微联通**(部署后):公网 `sso` 域名 + 企微可信域名已配 → 触发企微登录 → 成功拿到 `wecom_id`。
2. **OIDC code 交换**:data-analysis callback 收 Casdoor code → 换 token → userinfo。
3. **RLS 回归**(关键):不同部门/权限用户登录,数据隔离仍生效 —— 证明身份/权限分层没破坏数据权限。
4. **SSO 验证**:登 data-analysis 后,访问第二个 Casdoor client 应免再授权(Casdoor 会话命中)。
5. **双模式**:企微客户端内(Silent 静默)+ PC 外部浏览器(Normal 扫码)都能登录。

---

## 10. 关键风险
| # | 风险 | 状态 | 应对 |
|---|------|------|------|
| 1 | Casdoor WeCom provider 双模式 / 扫码端点 | ✅ 已实测消除 | 源码确认双模式 + 新端点(§3) |
| 2 | sqlite 非 Casdoor 最稳存储(官方主测 mysql) | ⚠️ 残留 | 切 mysql 仅改 `app.conf` `driverName`,成本低;用户量(几百企微成员)sqlite 足够,出问题再切 |
| 3 | `wecom-oauth` 退役边界 | ⚠️ 注意 | `signJwt` 被 `agent-query` 复用,迁移时保留该能力 |
| 4 | IdP 单点故障 | ⚠️ 架构固有 | 纳入监控告警;Casdoor 是登录唯一入口 |
| 5 | 企微可信域名配置依赖人工 | ⚠️ 部署前置 | `sso.shanhaiyiguo.com` 必须先在企微后台 App A 加可信域名,Casdoor 才能跑通 OAuth |

---

## 11. 范围边界
- **本轮(先基石)**:Casdoor 部署 + 企微 WeCom provider + data-analysis 登录迁移到 Casdoor(身份/权限分层,PostgREST/RLS 不动)。
- **后续轮次**:
  - WeKnora 接入(第一个外部 OIDC client,验证跨系统 SSO)。
  - 全 SSO 登出(RP-initiated / back-channel logout)。
  - 双模式按 UA 自动分发(若初版只配单 provider)。

---

## 12. 配置决策记录(2026-08-08)
| 决策 | 选择 | 理由 |
|------|------|------|
| IdP 选型 | **Casdoor** | 原生 WeCom provider(实测),Go 轻,docker 契合现有栈 |
| 存储后端 | **sqlite** | 单容器自带,身份数据独立,用户量不大足够;切 mysql 成本低 |
| 对外域名 | **独立子域名 `sso.shanhaiyiguo.com`** | OIDC issuer 干净,企微可信域名单配,与 data 站解耦 |
| 实施范围 | **先基石** | 先立统一身份中心跑通,WeKnora 接入下一轮验证扩展性 |
| 身份/权限分层 | data-analysis 自查 perms 自签 PostgREST JWT | 保护 RLS 零改动;身份与数据权限解耦 |

---

## 13. 实施时需同步更新的文档
- `docs/architecture.md`:§1 系统总览新增 Casdoor 节点;§6 鉴权系统改写(身份层迁 Casdoor,数据权限层保留);§7.1 App A 标注登录凭证迁 Casdoor;§9 已确认架构决策表加本次决策。
- `deploy/.env.example`:新增 Casdoor 相关变量(Casdoor 容器配置、data-analysis 的 OIDC client 配置)。
- 本 spec 自身:部署后回填端到端实测结果(§3.5)。
