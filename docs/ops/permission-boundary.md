# 权限职责边界：Casdoor 与本系统（data-analysis）

> 成文 2026-08-16；同日按 IAM 标准化 spec（`docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`，revision-2）更新为三分流边界。来源：权限页改造（`fix(permissions): 权限管理页对齐 Casdoor 职责边界`）+ 生产实探。
> 一句话：**Casdoor 认人授职定范围（你是谁、什么职位、能不能进管理台、看哪些品牌/品类/门店）；本系统只留临时例外与执行（temporary_grants + 行/列过滤）。**
> 权限体系配置（初始化/维护）：[permission-onboarding.md](./permission-onboarding.md)。

## 三层职责

| 层 | 管什么 | 在哪配置 | 生效路径 |
|---|---|---|---|
| **身份** | 谁是用户（OIDC sub） | Casdoor（sso.shanhaiyiguo.com） | OIDC 登录 → session cookie |
| **组织架构目录** | 部门/区域/门店层级（谁在哪个部门、哪个门店） | **Casdoor Group tree**（组同步器 auto + Casdoor UI manual；本地 org_departments/org_users 降级只读投影） | W2 影子同步 → W4 消费侧切（groups claim → data_scope.branch_nums） |
| **职位授权** | 谁担任 boss / zone_manager / manager / buyer / finance（`roles.id=1..5`） | Casdoor 角色归属 | 薄同步 → `org_users.role_id`（`role_source='auto'`；U2 后 role_codes 数组） |
| **admin 门禁资格** | 谁能进 `/admin/*`（token `permissions: ["data-analysis:admin"]`） | Casdoor permission 挂人/挂角色 | middleware / `requireAdmin` 验签 + claim |
| **能力点（功能资源）** | 看板/字段/门禁等 `data-analysis:*` 能力可配清单 | **catalog 单真相**（`web/lib/capability-catalog.ts` 代码派生）→ 同步进 Casdoor resource 表；Casdoor UI 勾选仅限 catalog ∪ `*` | scan 自动发现 + 部署钩子/cron 双通道同步 + 校验器 fail-close（architecture.md §6.4） |
| **数据范围（三分流）** | 品牌/品类/字段 → Casdoor resource；门店 → Group 挂组；临时例外 → `temporary_grants` RT 实查 | Casdoor（resource 判定 + 挂组）+ 本系统授权中心（例外表，带到期） | claims `data_scope`/`groups`/`fields` + 例外经 `pgrst_pre_request` 每请求并集（§6.5） |
| **角色默认数据范围**（legacy 双氧期） | 该职位默认能看哪些门店/品牌/品类/成本 | **本系统** `/admin/permissions` 角色 tab（`data_permissions.subject_type='role'`）——**W6 sunset 迁移中**（W5 DB 级写关闭 → W6 删表；目标态转 Casdoor resource/挂组） | `get_user_perms` 基底（W4 起消费侧切 data_scope） |
| **部门级范围**（legacy 双氧期） | 某部门整体看哪些门店/成本 | **本系统** `/admin/permissions` 部门 tab（`subject_type='dept'`）——**W6 sunset 迁移中**（部门语义转 Group tree 挂组） | `get_user_perms` 基底（并集） |
| **个人 override**（legacy 双氧期） | 覆盖默认（逐维 + 到期时间 + 备注）——**带到期者迁 temporary_grants 例外表，其余转 Casdoor** | **本系统** `/admin/permissions` 用户 tab → 单独授权（W6 sunset 迁移中） | `get_user_perms` 逐字段覆盖 |
| **应急兜底** | Casdoor 不可用时临时放行 admin | 服务器 env `BREAKGLASS_ADMINS`（当前 ZhangDuo,YangWei） | 门禁旁路 |

## 合成顺序（用户最终能看什么——claims data_scope 版，2026-08-16 IAM 标准化目标态）

```
Casdoor 职位 → org_users.role_codes 镜像（写穿，非真相源）
      → 数据范围三分流：
          品牌/品类/字段 = Casdoor resource 判定（data-analysis:brand:* / category:* / field:*）
          门店           = Group 挂组（groups claim → 门店叶子/区域组展开 → branch_nums）
          临时例外       = temporary_grants RT 实查（5min 缓存；★不折叠进 claims，撤销 ≤5min 生效；
                           经 pgrst_pre_request 每请求并集进专用 claim 段）
      → JWT claims：data_scope{brands, categories, branch_nums} + groups + fields + catalog_v
          ★空集 = deny：data_scope/groups 段存在但为空 = 授权确定为 ∅，禁止收敛 ["*"]
          （双氧期：顶层旧 key（brands/branch_nums/categories/can_see_cost）保留至 W6；
            legacy「空数组 → ["*"] 兜底」仅限无 data_scope 段的旧形状令牌，W4 切走后移除）
      → PostgREST 行级过滤（RLS 策略分支，迁移 179）：
          data_scope 段存在 → 读各维，空段 = deny；缺失 → 回退 legacy claim_match_or_star
          ★严禁对 data_scope 空段用 claim_match_or_star（空数组/NULL → true 全放）
      → 报表视图（行过滤 + 列掩码 fields.cost → 整列 NULL）
```

> 当前生产仍是 legacy 路径：`database/migrations/167_permission_consolidation.sql` 的 `get_user_perms`（角色∪部门基底 → 个人覆盖 → `*` 收敛）→ 顶层四维 claims → `claim_match_or_star`。W3 起新签发 claims 带 data_scope 新段、W4 消费侧切（策略分支）、W6 删旧 key——迁移窗口内新旧并存（双氧期）。
门禁与数据范围**独立**：`data-analysis:admin` 只管「能不能进管理台」，不替数据范围；数据范围目标态三分流（Casdoor resource/挂组 + 本系统例外表）。

## 实操：加人 → 授职 → 划范围

> 迁移态提示（2026-08-16）：下表「本系统 `/admin/permissions` 配数据范围」三行为 **legacy 双氧期操作**——W 轴迁移后：门店范围 → Casdoor Group 挂组（组同步器/W4 后）；带到期临时授权 → 授权中心例外 tab（temporary_grants，W5 后）；`data_permissions` W6 删表。迁移完成前按现状操作。

| 动作 | 去哪个系统 | 具体步骤 |
|---|---|---|
| **组织管理员登录 Casdoor** | **Casdoor** | 组织管理员（如 shanhai 的张铎）用 **`https://sso.shanhaiyiguo.com/login/shanhai`** 入口（URL 已 pin 组织，data-analysis 管理端外链就是此地址）；默认 `/login` 是 built-in 全局管理员登录页，组织管理员在那是登不进的。详见「组织管理员登录」一节 |
| 新员工入职 / 加企微账号 | 企微后台 | 加通讯录用户；本系统 `wecom-sync-contacts` 同步后出现在 `/admin/permissions` 用户 tab |
| 给某用户担任职位（如转店长） | **Casdoor** | Casdoor 管理端改该用户角色归属；薄同步后本地角色 badge 变「自动（店长）」 |
| 想让某人只有查看权给部门配范围 | 本系统 `/admin/permissions` 部门 tab（legacy，W6 sunset 迁移中） | 选部门 → 配门店范围/成本可见 → 保存 |
| 给某职位默认范围 | 本系统 `/admin/permissions` 角色 tab（legacy，W6 sunset 迁移中） | 编辑角色默认范围（逐维门店/品牌/品类/成本，作为所有该角色用户的基底） |
| 个别用户特殊收窄/放开 | 本系统 `/admin/permissions` 用户 tab → 单独授权（legacy，W6 sunset 迁移中） | 逐维 + 到期时间；留 NULL 维 = 该维继承基底 |
| 开/收 admin 管理台权限 | **Casdoor** | 挂/摘 `data-analysis:admin` permission |
| 给角色勾看板/字段能力点 | **Casdoor**（能力点勾选） | 勾 `data-analysis:view:*` / `field:*` / `brand:*` / `category:*`（可配清单以能力目录辅助页 `/admin/capabilities` 为准；非 catalog key 会被校验器拒绝） |
| 紧急放行 admin | 服务器 env | `BREAKGLASS_ADMINS` 加 wecom_id（兜底，勿常态使用） |

## 易混淆点的判据

- **改某人的职位** → Casdoor（「谁在什么职位」）。
- **改该职位的默认数据范围** → 本系统角色 tab（「这个职位能看什么」，legacy 双氧期；目标态品牌/品类随 resource、门店随挂组走 Casdoor）。两者绑定顺序：先有职位，角色行默认范围才生效。
- **门店范围（目标态）≠ 品牌品类范围**：门店 = Casdoor Group 挂组（组同步器建组/挂组，人挂门店叶子或区域组）；品牌/品类/字段 = Casdoor resource 勾选。临时例外（带到期）= 本系统例外表 RT 实查（**不折叠进 claims**，撤销 ≤5min 生效）。
- **admin 门禁 ≠ 数据权限**：manager 也能被授 admin（能进管理台），但数据范围由三分流合成决定。
- **页面体验**：用户/角色/部门 tab 的职位列均为只读（U1 起冻结），带「Casdoor 管理端」外链；本系统不写 `role_id`（PUT /users 对 role 字段返回 409）。

## 组织管理员登录（2026-08-16 定案）

- **问题**：张铎（组织管理员）点管理端「用户管理（Casdoor）」外链落在默认登录页（built-in 组织），永远登不进。
- **根因**：默认 `/login` pin built-in；组织管理员属 shanhai 组织，需 `/login/<org>` 入口；登录表单不支持 `org/username` 斜杠语法（会被当整体 username 去查）。
- **解决**：data-analysis 管理端外链统一指向 **`https://sso.shanhaiyiguo.com/login/shanhai`**（URL 路由 owner 参数 pin 组织）。全局管理员（built-in/admin）仍可走 `/login`。
- **后端确认**：`shanhai/ZhangDuo` 已授 `is_admin=true`（组织管理员，非全局），密码 123456（**待首次登录后改强密码**）；`POST /api/login`（JSON）验证通过，`get-account` 返回 `isAdmin:true`，可读 shanhai 组织 5 用户。
- **给新组织管理员开权限**：`UPDATE "user" SET is_admin=true WHERE owner='<org>' AND name='<wecom_name>'` + 设密码（bcrypt），登录入口 `<org>` 对应 `/login/<org>`。

## 相关文档

- UI 测试报告（含 finding-1 溯源）：`docs/ops/ui-e2e-report-2026-08-16.md`
- 架构：`docs/architecture.md`（权限/身份轨：§6.0 真相源总表 / §6.4 能力点 catalog / §6.5 view-group 与例外表 / §7.1.2 组同步双轨）
- spec：`docs/superpowers/specs/2026-08-15-platform-casbin-novu-unified-design.md`（身份/推送轨）；**`docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`（IAM 标准化 revision-2——本文三分流边界的单一需求源）**
