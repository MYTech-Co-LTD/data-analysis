# 权限职责边界：Casdoor 与本系统（data-analysis）

> 成文 2026-08-16。来源：权限页改造（`fix(permissions): 权限管理页对齐 Casdoor 职责边界`）+ 生产实探。
> 一句话：**Casdoor 认人授职（你是谁、什么职位、能不能进管理台）；本系统划范围（这个职位/部门/个人看哪些数据）。**

## 三层职责

| 反面 | 管什么 | 在哪配置 | 生效路径 |
|---|---|---|---|
| **身份** | 谁是用户（OIDC sub）、组织机构 | Casdoor（sso.shanhaiyiguo.com） | OIDC 登录 → session cookie |
| **职位授权** | 谁担任 boss / zone_manager / manager / buyer / finance（`roles.id=1..5`） | Casdoor 角色归属 | 薄同步 → `org_users.role_id`（`role_source='auto'`） |
| **admin 门禁资格** | 谁能进 `/admin/*`（token `permissions: ["data-analysis:admin"]`） | Casdoor permission 挂人/挂角色 | middleware / `requireAdmin` 验签 + claim |
| **角色默认数据范围** | 该职位默认能看哪些门店/品牌/品类/成本 | **本系统** `/admin/permissions` 角色 tab（`data_permissions.subject_type='role'`） | `get_user_perms` 基底 |
| **部门级范围** | 某部门整体看哪些门店/成本 | **本系统** `/admin/permissions` 部门 tab（`subject_type='dept'`） | `get_user_perms` 基底（并集） |
| **个人 override** | 覆盖默认（逐维 + 到期时间 + 备注） | **本系统** `/admin/permissions` 用户 tab → 单独授权 | `get_user_perms` 逐字段覆盖 |
| **应急兜底** | Casdoor 不可用时临时放行 admin | 服务器 env `BREAKGLASS_ADMINS`（当前 ZhangDuo,YangWei） | 门禁旁路 |

## 合成顺序（用户最终能看什么）

```
Casdoor 职位 → org_users.role_id
      → data_permissions: role行 ∪ dept行 → 基底（四维并集，can_see_cost=bool_or）
      → user 行该维「非 NULL」→ 逐维覆盖基底
      → 含 "*" 收敛为 ["*"]；空数组 → ["*"]（数据维兜底全放行）
      → JWT claims（brands / branch_nums / categories / can_see_cost）
      → PostgREST 行级过滤（perm.ts: claim_match_or_star）→ 报表视图
```

实现：`database/migrations/167_permission_consolidation.sql` 的 `get_user_perms`（角色∪部门基底 → 个人覆盖 → `*` 收敛）。
门禁与数据范围**独立**：`data-analysis:admin` 只管「能不能进管理台」，不替数据范围；数据范围永远在后端三层配。

## 实操：加人 → 授职 → 划范围

| 动作 | 去哪个系统 | 具体步骤 |
|---|---|---|
| **组织管理员登录 Casdoor** | **Casdoor** | 组织管理员（如 shanhai 的张铎）用 **`https://sso.shanhaiyiguo.com/login/shanhai`** 入口（URL 已 pin 组织，data-analysis 管理端外链就是此地址）；默认 `/login` 是 built-in 全局管理员登录页，组织管理员在那是登不进的。详见「组织管理员登录」一节 |
| 新员工入职 / 加企微账号 | 企微后台 | 加通讯录用户；本系统 `wecom-sync-contacts` 同步后出现在 `/admin/permissions` 用户 tab |
| 给某用户担任职位（如转店长） | **Casdoor** | Casdoor 管理端改该用户角色归属；薄同步后本地角色 badge 变「自动（店长）」 |
| 想让某人只有查看权给部门配范围 | 本系统 `/admin/permissions` 部门 tab | 选部门 → 配门店范围/成本可见 → 保存 |
| 给某职位默认范围 | 本系统 `/admin/permissions` 角色 tab | 编辑角色默认四维（作为所有该角色用户的基底） |
| 个别用户特殊收窄/放开 | 本系统 `/admin/permissions` 用户 tab → 单独授权 | 四维 + 到期时间；留 NULL 维 = 该维继承基底 |
| 开/收 admin 管理台权限 | **Casdoor** | 挂/摘 `data-analysis:admin` permission |
| 紧急放行 admin | 服务器 env | `BREAKGLASS_ADMINS` 加 wecom_id（兜底，勿常态使用） |

## 易混淆点的判据

- **改某人的职位** → Casdoor（「谁在什么职位」）。
- **改该职位的默认数据范围** → 本系统角色 tab（「这个职位能看什么」）。两者绑定顺序：先有职位，角色行默认范围才生效。
- **admin 门禁 ≠ 数据权限**：manager 也能被授 admin（能进管理台），但数据范围由三级合成决定。
- **页面体验**：用户/角色/部门 tab 的职位列均为只读（U1 起冻结），带「Casdoor 管理端」外链；本系统不写 `role_id`（PUT /users 对 role 字段返回 409）。

## 组织管理员登录（2026-08-16 定案）

- **问题**：张铎（组织管理员）点管理端「用户管理（Casdoor）」外链落在默认登录页（built-in 组织），永远登不进。
- **根因**：默认 `/login` pin built-in；组织管理员属 shanhai 组织，需 `/login/<org>` 入口；登录表单不支持 `org/username` 斜杠语法（会被当整体 username 去查）。
- **解决**：data-analysis 管理端外链统一指向 **`https://sso.shanhaiyiguo.com/login/shanhai`**（URL 路由 owner 参数 pin 组织）。全局管理员（built-in/admin）仍可走 `/login`。
- **后端确认**：`shanhai/ZhangDuo` 已授 `is_admin=true`（组织管理员，非全局），密码 123456（**待首次登录后改强密码**）；`POST /api/login`（JSON）验证通过，`get-account` 返回 `isAdmin:true`，可读 shanhai 组织 5 用户。
- **给新组织管理员开权限**：`UPDATE "user" SET is_admin=true WHERE owner='<org>' AND name='<wecom_name>'` + 设密码（bcrypt），登录入口 `<org>` 对应 `/login/<org>`。

## 相关文档

- UI 测试报告（含 finding-1 溯源）：`docs/ops/ui-e2e-report-2026-08-16.md`
- 架构：`docs/architecture.md`（权限/身份轨）、spec `docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md`