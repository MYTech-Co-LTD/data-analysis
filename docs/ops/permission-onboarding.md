# 权限体系配置手册（管理员从空系统初始化与日常维护）

> 成文 2026-08-17（v2 重写：定位从「单个人开通」改为「管理员从空系统初始化权限体系」）。
> 给运维/管理员本人：新环境组织架构已同步、Casdoor 组织/应用已就绪、但角色/权限还全空时，
> 按本手册从头把权限体系搭起来，并覆盖日常的单人开通/转岗/离职收权。
> 模型总览 / 职责边界 / Casdoor 机制分别见
> [permission-maintenance.md](./permission-maintenance.md) ·
> [permission-boundary.md](./permission-boundary.md) ·
> [casdoor-role-permission-mechanism.md](./casdoor-role-permission-mechanism.md)。
> 设计文档：docs/superpowers/specs/2026-08-17-permission-onboarding-design.md（v2）。

> ⚠️ **本手册的初始状态**：`org_users`/`org_departments` 已有数据（组织架构同步完成）、
> Casdoor 组织管理入口可登录，但 **Roles 列表为空、Permissions 列表为空**——这正是我们要补的。
> 已配好系统的日常单人开通/收权直接看 §7。

## 0. 一句话流程 + 开局速查

> 前置就绪 → 建 5 角色 → 建 5 权限 → 用户进角色（薄同步 auto）→ 管理台账号 → 数据范围确认 → 例外(可选) → 验证

**记住一句话**：**先角色、再权限、挂人靠薄同步自动、管理台单独授、范围随组织架构自动成立。**

| 步骤 | 做什么 | 去哪个系统 | 首次初始化必需 |
|---|---|---|---|
| 1 | 确认前置（组织架构已同步、Casdoor 可登录） | 本系统 + Casdoor | ✅ |
| 2 | 建 5 角色（boss/zone_manager/finance/manager/buyer） | Casdoor → Roles | ✅ |
| 3 | 建 5 权限（role-*）+ 勾资源（full 含 cost） | Casdoor → Permissions | ✅ |
| 4 | 用户进角色（薄同步自动，存量补挂） | Casdoor → Roles → Sub users | ✅（仅首次补存量） |
| 5 | 管理台账号（data-analysis:admin） | Casdoor permission | ✅ |
| 6 | 数据范围确认（门店=组、品牌品类成本=角色档位） | 一般自动成立，核对即可 | 核对即可 |
| 7 | 日常运维：单人开通 / 转岗 / 离职收权 | 企微 + 本系统 + Casdoor | 按需 |
| 8 | 例外通道（临时放开/收窄） | 本系统 `/admin/permissions` | 按需 |

**顺序铁律（防窗口期权限归零）**：先建角色（并挂人）→ 再建 permission 绑 Roles。
禁止先清 permission.Users 再挂角色。

## 1. 前置条件确认（组织架构已同步、Casdoor 就绪）

起点三查，缺一不可：

1. **组织架构已同步**：
   ```sql
   SELECT count(*) AS users FROM org_users WHERE is_active=true;
   SELECT count(*) AS depts FROM org_departments WHERE is_active=true;
   -- 两数都 > 0 → 组织架构 OK
   ```
2. **Casdoor 组织管理入口可登录**：`https://sso.shanhaiyiguo.com/login/shanhai`
   （⚠️ 默认 `/login` 是 built-in 全局管理员登录页，组织管理员在那里登不进；
   必须用带组织 pin 的 `/login/shanhai` 入口）。
3. **Roles / Permissions 为空是正确起点**：左侧 Roles、Permissions 列表应为空
   ——这正是本手册后面要补的。若已有内容，跳到 §7 日常运维。

【截图位】org_users 查询结果 / Casdoor Roles 空列表

## 2. 建 5 角色（Casdoor Roles）

1. Casdoor 组织管理入口 → **Roles** → 逐一添加 **5 个角色**：
   `boss` / `zone_manager` / `finance` / `manager` / `buyer`。
   > ⚠️ **名字必须与模板逐字一致**（小写下划线）——薄同步按推导码逐字写入 `Role.Users`，
   > 改名/换命名风格会让自动挂人全部落空。
2. 档位含义（full 含成本 / basic 不含）见附录 A；本步只建角色定义，不配权限。

| Role 名 | 档位 | 部门名派生来源 | 说明 |
|---|---|---|---|
| boss | full（含成本） | 总经办 / 运营总 / 老板 | 最高职权 |
| zone_manager | full（含成本） | 战区 / 区域 / 大区 | 战区负责人 |
| finance | full（含成本） | 财务 | 财务可见成本 |
| manager | basic（不含成本） | 店长 / 门店 / 无匹配默认 | 默认档 |
| buyer | basic（不含成本） | 采购 / 业务 / 品类 | 采销档 |

**API 备选**（脚本化初始化时）：
```bash
# 每个角色一次；name 即角色码，展示名可写中文
curl -s -X POST -H "Authorization: Bearer $CASDOOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner":"shanhai","name":"manager","displayName":"店长/门店","description":"basic 档默认角色"}' \
  https://sso.shanhaiyiguo.com/api/add-role
```
> ⚠️ Casdoor **没有 add-role-for-user 路由（404）**——后续挂人只能走
> `update-role` 全量 `Users`（见 §4），别去踩不存在的接口。

【截图位】Casdoor Roles 添加页（boss/zone_manager/finance/manager/buyer 五条建完态）

## 3. 建 5 权限（Casdoor Permissions，role-*）+ 资源勾选

权限（permission）=「这个角色能看到什么能力」的载体。5 个权限**与 5 角色同名前缀**：

| permission 名 | 绑角色 | 档位 | Resources 差异 |
|---|---|---|---|
| role-boss | boss | full | = basic 档资源 + `data-analysis:field:cost` |
| role-zone_manager | zone_manager | full | = basic 档资源 + `data-analysis:field:cost` |
| role-finance | finance | full | = basic 档资源 + `data-analysis:field:cost` |
| role-manager | manager | basic | 能力清单（见附录 B）不含 cost |
| role-buyer | buyer | basic | 能力清单（见附录 B）不含 cost |

1. Casdoor 组织管理入口 → **Permissions** → 逐一添加 5 个。
2. 每个 permission 两件事：
   - **Roles**：绑对应角色（`role-boss` 绑 `boss`……）← 授权来源（Role.Users 权威）
   - **Resources**：勾选能力，勾选依据 = **附录 B 能力清单**（full 档多加一个
     `data-analysis:field:cost`）
3. 提交后底层自动生成 p 策略（addPolicies，重开登录即可见）。

> ⚠️ **顺序铁律（防窗口期权限归零）**：本步在角色建好之后做；
> 若同一迁移里先清了 permission.Users 再挂角色，中间窗口 get-all-objects 为空 = 全员权限归零。
> 核心顺序：**先建角色+挂人 → 再建 permission 绑 Roles → 验证 → 最后才清 Users 双保险**。

> ⚠️ **编辑须知（AllCols 清空坑）**：改 Resources 必须**整表单提交**（控制台 UI 天然整表单，安全）；
> **严禁在 API 侧做局部 PATCH**（如只传 `isEnabled:false`）——Casdoor `update-permission` 是全列更新，
> 未传字段（users/groups/roles/resources/actions）会被清空为 NULL，权限列表页直接空白
> （`actions null.map()`），历史教训见附录 D / 机制文档 §3.3。

**API 备选**（`add-permission`；**直接 INSERT 数据库不生效**，必须走 API 触发 addPolicies）：
```bash
curl -s -X POST -H "Authorization: Bearer $CASDOOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "owner":"shanhai","name":"role-manager",
    "displayName":"basic 档：店长/门店",
    "roles":["manager"],
    "resources":["data-analysis:view:reports","data-analysis:view:reports-items",
                 "data-analysis:view:reports-targets","data-analysis:view:wholesale-customers",
                 "data-analysis:view-board:kpi","data-analysis:view-board:brand",
                 "data-analysis:view-board:region","data-analysis:view-board:item-top",
                 "data-analysis:view-board:category","data-analysis:view-board:supply-chain",
                 "data-analysis:view-board:wholesale",
                 "data-analysis:view-kpi:sale","data-analysis:view-kpi:delivery",
                 "data-analysis:view-kpi:outbound_amt","data-analysis:view-kpi:outbound_profit",
                 "data-analysis:view-kpi:delivery_sale_ratio","data-analysis:view-kpi:outbound_margin",
                 "data-analysis:brand:3120","data-analysis:brand:64188",
                 "data-analysis:category:水果","data-analysis:category:标品","data-analysis:category:耗材"],
    "actions":["*"],"effect":"Allow"
  }' https://sso.shanhaiyiguo.com/api/add-permission
```
full 档 3 个在以上基础上加一行 `"data-analysis:field:cost",` 到 resources 数组。

【截图位】Permissions 添加页 / Resources 勾选态（full vs basic 差异处圈出 cost）

## 4. 用户进角色（薄同步 auto 为主）

建好角色定义后，**挂人基本是自动的**：

1. **自动（日常路径）**：薄同步每 30 分钟一轮（`*/30 * * * *`），按部门名派生规则
   （见附录 A）把用户写进对应 `Role.Users`。第 2 步建好角色定义即自动开跑，**无需手动**。
2. **存量用户补挂（首次初始化，可选，不用等 30 分钟）**：Casdoor → 组织管理入口 → **Roles** →
   目标角色 → **Sub users** → 加人；或 API `update-role` **全量 Users**（Casdoor 无 add-role-for-user）。
   - 多部门用户：取 priority 最高（总经办类最高），与自动推导一致。

> ⚠️ **Sub users 下拉只显示「工号」**（Casdoor 前端写死只渲染 `owner/name`，中文名永远不出现，
> 非配置项）。认人请对照本系统 `/admin/permissions` 用户列表（中文名 + 工号两列），别靠猜。

> **覆盖规则（防橡皮擦）**：本系统 `role_codes` 镜像里含推导码之外的「附加角色」时，
> 薄同步会**跳过写入**，交给 drift 对比后把该用户翻成 `manual` 保护——手动改过的角色
> 在后续轮询里不会被打回默认推导。

【截图位】Sub users 编辑态（下拉显示工号）

## 5. 管理台账号（data-analysis:admin）

管理台（`/admin/permissions` 等 `/api/admin/**`）判定链：
**token claims 的 permissions 数组命中 `data-analysis:admin`** →
放行；否则看 `BREAKGLASS_ADMINS` env 兜底名单。此能力**不随角色档位派生**，单独手动授。

1. 建议建一个**专职运维账号**（不用业务角色兼任，便于收权审计）。
2. Casdoor → 组织管理入口 → **Permissions**（role-* 之外的独立 permission，或加在某角色的
   Resources）→ Resources 勾选 `data-analysis:admin`。
3. 验证：该账号登录后能进 `/admin/permissions`（middleware + 路由内 `requireAdmin` 双层门禁）。

【截图位】admin 能力勾选 / 管理台可达