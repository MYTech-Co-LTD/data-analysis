# Casdoor roles claim 格式验证（V2）

> 状态：**已验证（实测 token 解码 + 源码 file:line 双证据）**。Task 13（U2 callback）以本文「契约快照」为准，不得凭假设。
> 验证日期：2026-08-15。实例：生产 Casdoor `https://sso.shanhaiyiguo.com`（控制面 `opsh`=/`113.249.101.33` `/opt/casdoor`）。
> 源码：`~/Documents/mytechcode/source-analysis/casdoor`（只读，commit `7f622b18`，2026-08-10）。

## TL;DR（对 Task 13 的直接影响——重要，与假设相反）

| 问题 | 结论 |
|---|---|
| access token 里有没有 roles claim？ | **当前配置下没有**。data-analysis app `token_format=JWT-Standard`，该格式**根本不产出 roles claim**（实测+源码双证）|
| roles 历史上的「逗号分隔字符串」格式？ | 当前版本不存在。所有路径均为**数组**：userinfo=字符串数组、JWT(全量格式)=对象数组 |
| 要在 token 里拿 roles | 须把 app `token_format` 改为 `JWT`（全量）→ roles = **对象数组** `[{owner,name,displayName,...}]` |
| 不改 token 格式的替代 | code 换 token 后调 `GET /api/userinfo` → roles = **字符串数组**（role.Name），`scope` 须含 `profile` |
| 当前生产库角色数据 | **role 表为空（0 条）**，shanhai org 5 个用户均无角色——上线前须先建角色 |

## 1. 实测过程与结果

### 1.1 client_credentials 路径（brief 原定路径——受阻，证据如下）

凭证来自控制面 DB（`ssh opsh` → `docker exec casdoor-postgres psql -U casdoor -d casdoor`）：

- `application` 表：`data-analysis | client_id=7de805b911819f85a47d | org=shanhai`（secret 本文档不落盘，溯源方式已记录）。

实测请求与原始响应：

```
curl -s -X POST https://sso.shanhaiyiguo.com/api/login/oauth/access_token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"7de805b911819f85a47d","client_secret":"<secret>"}'

→ {"error":"unsupported_grant_type","error_description":"grant_type: client_credentials is not supported in this application"}
```

DB 佐证：`SELECT name, grant_types FROM application;` → `app-built-in|null`、`data-analysis|[]`、`weknora|["authorization_code"]`、`customerb-app|["authorization_code","password"]` —— **没有任何 app 启用 client_credentials**。

且源码证明该路径即使开通也**不代表用户角色格式**：`object/token_oauth.go:351-373` `GetClientCredentialsToken` 用 `nullUser`（仅 owner/id/name/type 四字段的合成 user）签发 token，其 roles 恒为 nil → `object/token_jwt.go:486-496` `refineUser` 补成 `[]`。**client_credentials token 的 roles 永远是空数组，无法用于验证角色格式**（此为对 brief 假设的实质纠偏，非偷懒跳过）。

### 1.2 实测替代路径：解码真实用户 access token（只读）

`token` 表存有 U2 生产流程（WeCom 静默 SSO）2026-08-14 真实签发的 access token。取最新一条解码 payload（只读 SELECT，未改任何数据）：

```
claim keys: ['address','aud','azp','exp','iat','id','iss','jti','name','nbf',
             'owner','picture','preferred_username','provider','scope','sub','tokenType']
roles:  null          ← 没有 roles claim
groups: null
scope: 'openid profile' | provider: 'wecom_silent' | sub: 'ShanHaiYiGuoDaXiong'
iss: https://sso.shanhaiyiguo.com | aud: ['7de805b911819f85a47d'] | tokenType: 'access-token'
```

**结论（实测）**：生产 U2 流程当前签发的 access token **不含 roles claim**。

### 1.3 源码归因（为何没有）

- app 配置：`SELECT token_format, token_fields FROM application WHERE name='data-analysis'` → **`JWT-Standard`**、token_fields 空。
- `JWT-Standard` 走 `ClaimsStandard`（`object/token_standard_jwt.go:25-39`），其嵌入的 `UserStandard`（`object/token_jwt.go:54-64`）只有 owner/name/id/displayName/avatar/email/phone —— **结构里就没有 roles 字段**，与实测吻合。
- 全量 `JWT` 格式走 `ClaimsWithoutThirdIdp`（`object/token_jwt.go:583-586`），嵌入 `UserWithoutThirdIdp`，其 `Roles []*Role json:"roles"`（`object/token_jwt.go:144`）→ roles = **对象数组**，nil 被 `refineUser` 补成 `[]`（`token_jwt.go:499-501`）。Role 对象字段见 `object/role.go:28-39`：`owner/name/displayName/users/groups/...`，**角色码 = `name` 字段**。
- `JWT-Custom`（token_fields 白名单）可按字段挑选，roles 以 Role 对象形式进 claim（`token_jwt.go:601+`）。

### 1.4 userinfo 端点（不改 token 格式的取 roles 路径）

`GET /api/userinfo`（`controllers/account.go:735-756` → `object/user.go:1213+` `GetUserInfo`）：

- 返回 `Userinfo` 结构（`object/user.go:250-266`）：`Roles []string json:"roles,omitempty"` —— **字符串数组**，元素 = `role.Name`（`user.go:1256-1261`）。
- 门槛：① access token 的 `scope` 含 `profile`（实测 token 已满足）；② app `token_fields` 为空 = 全字段放行（data-analysis 现状满足）；③ `omitempty`——**无角色时字段整体缺席**（不是空数组），解析侧必须按「缺失=无角色」处理。
- 角色来源还会经 `ExtendUserWithRolesAndPermissions` 扩展（用户显式角色 + 所属 group/role 递归并入）。

## 2. 契约快照（Task 13 实现以此为准，不得凭假设）

### 2.1 推荐路径（不改 app token_format）：userinfo 取 roles

```text
# U2 callback 拿到 code 后：
1. POST /api/login/oauth/access_token (grant_type=authorization_code, client_id/secret, code)
2. GET /api/userinfo  (Bearer access_token；scope 已含 profile，实测满足)
3. 解析 roles claim：
   roles = payload["roles"]          # JSON 字符串数组，如 ["admin","viewer"]；无角色时字段缺失
   if "roles" not in payload or payload["roles"] is None:
       role_codes = []               # 缺失=无角色（omitempty 语义），不得抛错
   elif isinstance(roles, str):      # 防御性：历史传闻的逗号串——当前版本源码不存在此形态，
       role_codes = [r.strip() for r in roles.split(",") if r.strip()]   # 防御分支，命中即告警+记日志
   elif isinstance(roles, list):
       role_codes = [ r if isinstance(r, str) else r["name"] for r in roles ]  # str(userinfo)/obj(JWT 全量) 双兼容
   else: REJECT  # 未知形态，fail-closed
4. role_code 单值 = priority 最高（C5）：
   # C5 取值规则：从 role_codes 里按本系统角色优先级表取最高者作为唯一 role_code
   role_code = max(role_codes, key=lambda c: ROLE_PRIORITY.get(c, -1)) if role_codes else None
   # ROLE_PRIORITY 在 bridge 配置中显式声明（如 {"admin":100,"analyst":50,"viewer":10}），
   # 未登记的角色 priority=-1 不参与单值选取但保留在 role_codes 全集里供授权层判断
```

### 2.2 备选路径（改 app `token_format: JWT-Standard → JWT`）

- 改后 access token 直接带 `roles: [{owner:"shanhai", name:"<角色码>", displayName:..., ...}]`（**对象数组**，元素取 `.name` 为角色码）。
- 代价：token 体积显著增大（实测 Standard 版 ~1.5KB，全量版会带上 permissions/groups 等），且属 app 配置变更——**须走架构变更流程（改配置前先在 dev 验证）**，本验证不擅自改。

### 2.3 前置缺口（实现 Task 13 前必须补）

1. **role 表为空**（实测 `SELECT count(*) FROM role` → 0）：须先在 Casdoor 建角色并绑定用户/组，否则任何路径 roles 均为空。
2. shanhai org 现有 5 个用户均无角色分配。
3. 角色码命名（与 data-analysis 侧 role_code 对齐）待 Task 13 落地时定表。

### 2.4 显式保留待验证项（RT-13 口径）

- userinfo 的 `ExtendUserWithRolesAndPermissions` 递归展开细节（group→role 嵌套）未实测（当前无角色数据可测）；实现后用真实角色回归一次。
- `JWT-Custom`（token_fields 白名单）路径未实测，若未来走该路径须补验。

> 后续实现以本快照为准；client_credentials 实测请求/响应与真实 token 解码结果均已记录于上，如与后续线上行为不符，以实测为准并回改本文档。
