# Casdoor U1a 种子配置清单（人执行）

> Task: plan Task 11 / spec §5.6（JWKS 验签共享件配套的控制面种子）。
> 执行环境：生产 Casdoor `https://sso.shanhaiyiguo.com`（控制面 `opsh` = `ssh opsh` → `/opt/casdoor`）。
> 执行人：管理员，在 Casdoor 控制台 UI 操作；本清单含每步 UI 路径与验证命令。
> 源码依据：`~/Documents/mytechcode/source-analysis/casdoor`（commit `7f622b18`，只读）；
> roles claim 契约见 `docs/ops/casdoor-roles-claim-verification.md`。
>
> **重要背景（V2 契约验证发现）**：生产 Casdoor `role` 表当前 **0 行**——shanhai org 5 个用户
> 均无角色。角色建设是 U1/U2 一切权限链路的前置条件，**本清单第 1 步优先级最高**。

---

## 第 0 步：前置检查

```bash
# JWKS 端点可达（token-verify.ts 验签的公钥来源）
curl -s https://sso.shanhaiyiguo.com/.well-known/jwks | jq '.keys[].kid'

# 角色表现状（应为 0 行，即本清单要修的缺口）
ssh opsh "docker exec casdoor-postgres psql -U casdoor -d casdoor -c 'SELECT count(*) FROM role;'"
```

---

## 第 1 步：角色建设（最高优先，生产 role 表 0 行）

**为什么**：spec 契约测试要求 `Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}`
（双向 diff 空）。因此 Casdoor 角色的 **Name（code）必须与 data_permissions 里 role 行的
subject_id（=role code）逐字符一致**，多一个少一个都会打断 U2 的 roles→数据范围镜像链。

**UI 路径**：Casdoor 控制台左侧菜单 → **Roles** → **Add**，逐条录入下表 6 行。
组织选 `shanhai`；`Name` 填英文 code（**只能字母开头，禁止纯数字**，Casdoor 对 role name
有格式校验）；`Display name` 填中文；Sub user / Sub domains 留空。

| # | Name（code，与 data_permissions 一致） | Display name（中文） | 对应数据库种子 |
|---|---|---|---|
| 1 | `boss` | 老板/运营总 | migration 072 roles 行 1 |
| 2 | `zone_manager` | 战区主管 | migration 072 roles 行 2 |
| 3 | `manager` | 店长 | migration 072 roles 行 3 |
| 4 | `buyer` | 采购/业务 | migration 072 roles 行 4 |
| 5 | `finance` | 财务 | migration 072 roles 行 5 |
| 6 | `admin` | 管理员 | **Casdoor 侧独有**，不进 data_permissions（数据范围全量，见契约 ∪ {admin}） |

> 注意：`admin` 是功能权限角色（web 端 `data-analysis:admin` 挂它），不是第 6 个数据范围
> 角色；data_permissions 只认 5 个业务角色 code。

**录入后验证**：

```bash
ssh opsh "docker exec casdoor-postgres psql -U casdoor -d casdoor -c \
  \"SELECT name, display_name FROM role WHERE owner='shanhai' ORDER BY name;\""
# 期望 6 行，name 集合 = {admin,boss,buyer,finance,manager,zone_manager}
```

（可选，等 Task 12 镜像列落地后跑契约测试：`Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}` 双向 diff 空。）

---

## 第 2 步：openclaw-gateway Agent 应用

**为什么**：OpenClaw push-admin / data-query 插件以服务身份（client_credentials）调 web 内部
API（spec §6.1 三层鉴权第①层），需要一个专用 Casdoor Application，不与人类登录用的
`data-analysis` app 混用。

**UI 路径**：左侧菜单 → **Applications** → **Add**，按下表配置：

| 字段 | 值 | 说明 |
|---|---|---|
| Name / Display name | `openclaw-gateway` / `OpenClaw Gateway` | token 的 `sub` 即此 name（源码 `token_oauth.go` nullUser.Name=application.Name） |
| Organization | `shanhai` | |
| Category | `Agent` | 下拉无此预设则手填（字段为 varchar(20) 自由值） |
| Grant types | 勾选 **`client_credentials`**（只勾这一个） | 源码已证支持：`object/token_oauth.go` `GetClientCredentialsToken`；生产其它 app 均未开启（`data-analysis` grant_types=[]），本 app 是第一个 |
| Scopes（自定义 scope） | 新增两条：`openclaw:query`（显示名「查询」）、`openclaw:push`（显示名「推送」） | `Application.Scopes`（`application.go:84` ScopeItem）；换 token 时请求的 scope 必须落在该白名单内，否则 `InvalidScope`（`token_oauth_util.go` IsScopeValidAndExpand） |
| Token expire（ExpireInHours） | `24` | 应用签发的 access token 有效期 24h；OpenClaw 插件侧按 60s 前置刷新（spec §6.1）使用 |

保存后：

1. 在应用详情页记录自动生成的 **Client ID**（形如 40 位 hex）。
2. 若 Client secret 未生成，点 **Generate** 产生一个。
3. **存放**：写入 OpenClaw 服务器的 `.env`（不进任何 git 仓）：
   ```dotenv
   CASDOOR_CLIENT_ID=<生成的 clientId>
   CASDOOR_CLIENT_SECRET=<生成的 secret>
   CASDOOR_TOKEN_URL=https://sso.shanhaiyiguo.com/api/login/oauth/access_token
   # 插件按需请求的 scope（必须都在应用 Scopes 白名单内）
   CASDOOR_SCOPE_PUSH=openclaw:push
   CASDOOR_SCOPE_QUERY=openclaw:query
   ```

**验证（换 token + JWKS，两条都要过）**：

```bash
# ① client_credentials 换 token：scope 落白名单
curl -s -X POST https://sso.shanhaiyiguo.com/api/login/oauth/access_token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"<CLIENT_ID>","client_secret":"<SECRET>","scope":"openclaw:push"}' | jq .
# 期望：access_token 非空、scope="openclaw:push"、token_type=Bearer
# 反例（scope 不在白名单 → error invalid_scope）：
#   把 scope 换成 "foo:bar" 再发一次，期望 {"error":"invalid_scope"}

# ② 解码 token 核对 claims（不验签，仅看 payload）
curl -s -X POST https://sso.shanhaiyiguo.com/api/login/oauth/access_token \
  -H 'Content-Type: application/json' \
  -d '{...同上...}' | jq -r .access_token | cut -d. -f2 | base64 -d | jq '{iss,aud,sub,scope,exp}'
# 期望：iss=https://sso.shanhaiyiguo.com，aud=[<CLIENT_ID>]，sub=openclaw-gateway，scope 含 openclaw:push

# ③ JWKS 仍可达（web 侧 token-verify.ts 用同一端点验签）
curl -s https://sso.shanhaiyiguo.com/.well-known/jwks | jq '.keys[].kid'
```

---

## 第 3 步：Permissions 资源 × 角色挂配

**UI 路径**：左侧菜单 → **Permissions** → **Add**，逐资源建一条 Permission：
`Resource` 填 `data-analysis`，`Action` 填下表动作段，`Subjects/Roles` 按建议表挂角色，
`Effect=Allow`，`State=Active`。最终功能门禁串 = `资源:动作`（如 `data-analysis:admin`，
与 `web/lib/feature-perm.ts` 的 perm 串逐字符一致）。

**资源清单 × 角色挂配建议表**（「✓」= 挂配；人可按组织实际调整，调后同步本文）：

| 资源（Permission Resource:Action） | admin | boss | zone_manager | manager | buyer | finance | 用途 |
|---|---|---|---|---|---|---|---|
| `data-analysis:admin` | ✓ | | | | | | 管理入口（requireAdmin 收口） |
| `data-analysis:report-center:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 报表中心只读 |
| `data-analysis:push:configure` | ✓ | ✓ | | | | | push-admin 配置推送（选人/内容） |
| `data-analysis:push:broadcast` | ✓ | ✓ | | | | | 全员 selector（引擎闸兜底，spec §5.2 不变量 8） |
| `data-analysis:dimensions:edit` | ✓ | | | | ✓（可选） | | 维表维护（门店/商品/目标） |

**录入后验证**：

```bash
# permission 行数与挂角落数
ssh opsh "docker exec casdoor-postgres psql -U casdoor -d casdoor -c \
  \"SELECT name, resource, action FROM permission WHERE owner='shanhai';\""
# 期望 5 行，resource 全为 data-analysis，action ∈ {admin, report-center:read, push:configure, push:broadcast, dimensions:edit}
```

---

## 第 4 步（收尾核对）：与 web 侧验签件对齐

web 侧 `web/lib/token-verify.ts`（本 task 落地）的验签参数来自 `deploy/.env`：

```dotenv
CASDOOR_CLIENT_ID=<openclaw-gateway 的 clientId>   # aud 校验
CASDOOR_JWKS_URL=https://sso.shanhaiyiguo.com/.well-known/jwks  # 可省略，此为默认值
CASDOOR_ISSUER=https://sso.shanhaiyiguo.com         # 已有，iss 校验
```

用第 2 步①拿到的 access_token 打 web 内部 API（push API 落地后）：验签通过返回 200/业务码，
scope 不符返回 403——即 fail-close 行为已被 e2e 亲证。

---

## casdoor-infra 仓同步

`~/Documents/mytechcode/casdoor-infra` 的 `init/`（`init/shanhai-roles.md`、
`init/openclaw-gateway.md`）按本文内容回填——**由编排者事后同步，本 task 不动那个仓**。

## 完成标准（人核对）

- [ ] role 表 6 行（5 业务 code + admin），name 与 data_permissions role 行 subject_id 精确一致
- [ ] openclaw-gateway app：client_credentials 唯一 grant type、Scopes 白名单含 openclaw:query/openclaw:push、ExpireInHours=24
- [ ] clientId/secret 只存 OpenClaw .env，未进 git
- [ ] 5 条 data-analysis Permission 按建议表挂角色
- [ ] 第 2 步三条 curl 验证全过（含 scope 反例 invalid_scope）
