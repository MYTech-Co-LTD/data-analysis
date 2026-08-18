# 权限体系配置手册设计（管理员从零初始化与日常维护）

> 成文 2026-08-17。状态：设计已确认（v1 单人开通流程版 → **v2 重定向为「管理员从空系统初始化权限体系」**）。

> ⚠️ **v2 重定向（2026-08-17，用户反馈）**：v1 手册的预设是「系统已配好、给单个新人走查」（主线 = 同步→JIT→角色核对→验证），
> 视角错了。真实场景是**管理员从空系统冷启动**：组织架构已同步（org_departments/org_users 有数据）、
> Casdoor 组织/应用/OIDC 登录已就绪，但 **Roles / Permissions 全空**——手册要教的是「后面怎么一步步把权限体系搭起来」。
> v2 结构：`前置条件 → 建 5 角色 → 建 5 权限 → 用户进角色 → 管理台账号 → 数据范围确认 → 例外 → 日常运维（单人开通/转岗/离职）`。
> 交付物仍是 `docs/ops/permission-onboarding.md`（文件名不变，内容重写；三份既有文档的反向互链不改）。

## 一、背景与目标

平台权限 2026-08-17 标准化后（Casdoor = 管理面真相源，data-analysis = 执行面），
权限模型与机制文档已齐（模型/边界/机制三件套），但缺一份**管理员从零把权限体系配起来**的实操手册：
新环境（组织架构同步完、角色权限还空着）时，没有文档告诉管理员「按什么顺序、去哪、点哪、勾什么、怎么验证」。

**目标**：一份**管理员本人照着点**的系统初始化手册——空系统（权限/角色为 ∅）→ 建角色 → 建权限 →
挂人 → 管理台账号 → 数据范围确认 → 验证 → 日常维护（单人开通/转岗/离职）。先文字版交付，截图日后按落位表补齐。

## 二、现状文档格局（新手册的定位）

| 文档 | 讲什么 | 新手册关系 |
|---|---|---|
| `docs/ops/permission-maintenance.md`（模型总览） | 模型表 + 例外通道 + 看板能力 + 排障命令 | 互链：模型参考 |
| `docs/ops/permission-boundary.md` | 职责边界（三层职责 + 合成顺序 + 实操表） | 互链：边界不清时引用 |
| `docs/ops/casdoor-role-permission-mechanism.md` | Casdoor 角色/权限源码级机制 + **落地方案（§3.3 真机步骤 = 初始化素材）** | 互链：机制疑点引用；§3.3 是初始化顺序的事实来源 |
| `docs/ops/permission-onboarding.md`（**v2 重写，本文档的交付物**） | **管理员初始化 + 日常维护操作手册** | 文首互链上述三份 |

## 三、手册定位参数

- **受众**：运维/管理员本人（懂系统术语；抄命令、点 UI 即可完成）
- **形态**：全文字版 + 每步「截图落位」标注（截图日后补齐）
- **存放**：`docs/ops/permission-onboarding.md`（文件名不变；三份既有文档反链已指向它，无需改动）
- **范围**：初始化主线（角色/权限从空到齐）+ 日常运维（单人开通/转岗/离职收权）；不含 legacy data_permissions 已下线内容
- **操作载体**：**Casdoor 控制台 UI 为主**（整表单提交，天然规避 AllCols 清空坑），关键步骤附等价 API 命令作备选/脚本化
- **角色模板**：**照抄现有 5 角色模型**（boss/zone_manager/finance=full 含成本；manager/buyer=basic 不含成本），
  与 `derive-roles.ts` 派生规则、薄同步 auto 写入一一对应——初始化成什么、后续自动维护就是什么，无漂移。管理台 `data-analysis:admin` 不随派生，单独手动授。

## 四、手册结构（章节大纲 = 交付物骨架）

### 0. 一句话流程 + 开局速查
> 前置就绪 → 建 5 角色 → 建 5 权限 → 用户进角色（薄同步 auto）→ 管理台账号 → 数据范围确认 → 例外(可选) → 验证
- 一句话：**先角色、再权限、挂人靠薄同步自动、管理台单独授、门店范围 = `范围|X` 资源显式挂**（2026-08-18 演进——废除组织架构自动推导，无范围资源 = 空集 deny）。
- 开局速查表：每步一句话 + 去哪个系统（Casdoor/本系统）+ 是不是首次必需。

### 1. 前置条件确认（组织架构已同步、Casdoor 就绪）
- `SELECT count(*) FROM org_users;` / `org_departments` 非空（同步成功）
- Casdoor 组织管理入口可登录：`https://sso.shanhaiyiguo.com/login/shanhai`（⚠️ `/login` 是 built-in 管理员登录页，组织管理员登不进）
- Roles 列表为空、Permissions 列表为空 = 是对的起点（本手册的初始状态）
- 【截图位】组织架构查询 / Casdoor Roles 空列表

### 2. 建 5 角色（Casdoor Roles）
- 控制台：组织管理入口 → Roles → 添加 5 个：boss / zone_manager / finance / manager / buyer
- 模板固定（照抄，勿改名——薄同步按名写入）| 档位 full/basic 见附录 A
- API 备选：`add-role`（owner/name）
- 【截图位】Roles 添加页

### 3. 建 5 权限（Casdoor Permissions，role-*）+ 资源勾选
- 控制台：组织管理入口 → Permissions → 添加 5 个：role-boss / role-zone_manager / role-finance（full 档）/ role-manager / role-buyer（basic 档）
- 每权限：**Roles 绑对应角色**（授权来源）+ **Resources 勾选能力清单**（附录 B）
  - full 档 = basic 档能力 + `data-analysis:field:cost`
  - Resources 以能力清单（catalog 单真相）为准，逐项勾
- ⚠️ 编辑须知：改 Resources 必须**整表单提交**（UI 天然整表单）；API 侧严禁局部 PATCH（AllCols 全列更新清空其余字段，见附录 D / 机制文档 §3.3 教训）
- ⚠️ 事务化顺序（机制文档 §3.4）：先建角色+挂人 → 再建 permission 绑 Roles，验证后清 Users 双保险；**禁止先清 permission.Users 再挂**（窗口期权限归零）
- API 备选：`add-permission`（触发 addPolicies 生成 p 策略；直接 DB INSERT 不生效）
- 【截图位】Permissions 添加页 / Resources 勾选态

### 4. 用户进角色（薄同步 auto 为主）
- **自动**：薄同步每 30 分钟一轮，按部门名派生规则写 Casdoor Role.Users（`derive-roles.ts`）；此手册第 2 步建好 5 个 Role 定义后，薄同步即开始自动挂人，无需手动
- **存量用户补挂（可选，无需等 30 分钟）**：手动 `update-role` 全量 Users（Roles → 目标角色 → Sub users → 加人，或 API）；多部门取 priority 最高
- ⚠️ Casdoor UI 下拉只显示工号（前端写死 `owner/name` 渲染），认人对照本系统 `/admin/permissions` 用户列表（中文名+工号）
- 覆盖规则：本地 role_codes 镜像含推导码之外的附加角色 → 薄同步跳过写入（防橡皮擦），drift 翻转 manual 保护
- 【截图位】Sub users 编辑态

### 5. 管理台账号（data-analysis:admin）
- 管理台判定：`checkFeaturePerm(uid,'data-analysis:admin')`——token claims permissions 命中，或 `BREAKGLASS_ADMINS` env 兜底
- 授权方法：给目标用户的 Casdoor permission Resources 加 `data-analysis:admin`（或绑到带它的角色）
- 建议：专职运维账号（不用业务角色兼任），密码走密码重置流程
- 【截图位】admin 能力勾选

### 6. 数据范围确认（2026-08-18 演进：门店=`范围|X` 资源、品牌/品类/成本=角色档位）
- **门店 = `范围|X` 资源**（2026-08-18 废除组织架构推导）：在目标用户的 Casdoor permission Resources 加 `范围|全店` / `范围|战区包名` / `范围|branch_number` / `范围|门店中文名` → 登录 `expandScopeResources` 展开 → `data_scope.branch_nums` → RLS 行过滤。**无范围资源 = 空集 deny**（B1 fail-close，不再从企微部门组推导）
- 品牌/品类/成本 = 角色档位资源（full 含 cost / basic 不含）；一般自动成立，不用手动勾
- 收窄时才动 permission Resources——**必须整表单提交或删建**（防 AllCols 清空）
- 【截图位】permission Resources 列表

### 7. 日常运维：单人开通 / 转岗 / 离职收权
（v1 手册主体收敛于此，操作命令沿用 v1 已核对事实）：
- **单人开通**：企微加人 → 通讯录同步（`curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts`，每日 03:17 兜底）→ 薄同步 JIT 建户挂组（≤30min，`name`=工号、`displayName`=中文名）→ 角色自动推导 → 验证三步
- **验证三步**（DB 视角合成 / claims 预览 / 真实会话）：`SELECT * FROM get_user_perms('<工号>');`、`GET /api/admin/permissions/preview?wecom_id=<工号>`、登录看板
- **转岗换角色**：改部门 → 薄同步按新部门重推导写 Casdoor；无附加角色时旧角色自动摘除
- **离职收权**：企微停用/删除 → 同步写 `is_active=false` → 薄同步 actionDisable（≤30min）：Casdoor disable + `casdoor_writer='disabled'` + `token_blacklist` 拉黑（7 天窗口旧 JWT 即刻拒）；核对 `SELECT wecom_id,casdoor_writer,is_active FROM org_users WHERE wecom_id='<工号>';`
- 例外回收：`/admin/permissions`「例外」撤销（到期自动失效）
- 【截图位】preview 响应 / 看板实际可见 / 例外撤销 / 离职用户状态

## 附录
- **A. 角色/权限速查表**：5 角色码 ↔ 档位（cost 有/无）↔ 派生来源 ↔ 对应 permission；管理台能力单列
- **B. 能力清单**（Resources 勾选依据，catalog 单真相）：7 看板 `view-board:*` + 6 KPI 卡 `view-kpi:*` + 4 视图 `view:reports*` + 品牌 `brand:3120/64188` + 品类 `category:水果/标品/耗材` + `field:cost` + `admin`（单真相：`web/lib/capability-board.ts` / `capability-catalog.ts`；新增看板/卡片按单真相同步）
- **C. 截图落位表**：逐步骤「截哪个界面 → 圈哪里 → 建议文件名」（正文【截图位】对应）
- **D. 排障与坑**：身份（Casdoor 拒建/outbox）、角色（auto vs manual 漂移）、范围（preview vs get_user_perms）、Permissions 页空白（update-permission AllCols 清空 → actions null.map）等

## 五、真实链路事实锚点（均已核对代码，2026-08-17）

| 事实 | 依据 |
|---|---|
| 5 角色 + 5 permission 真机落地顺序 | `casdoor-role-permission-mechanism.md` §3.3（2026-08-17 已执行：建角色→挂人→建 5 permission→验证 44/45） |
| 事务化顺序（先角色+挂人、后 permission，防窗口期归零） | 机制文档 §3.4 |
| add-role-for-user 不存在（404）→ 挂 Role.Users 必须 update-role 全量 | 机制文档 §五 验证矩阵 |
| update-permission AllCols 清空坑 | 机制文档 §3.3 副作用（object/permission.go:175）；修复=删建 |
| 薄同步 30 分钟：`*/30 * * * *` | `web/lib/jobs/thin-sync/manifest.ts:225` |
| 通讯录全量兜底 03:17 | `web/lib/jobs/contact-sync/manifest.ts:17` |
| 手动触发同步 | `curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts` |
| JIT 建户带 displayName | `web/lib/sync/casdoor-client.ts` provisionUser |
| 角色派生规则 | `web/lib/sync/derive-roles.ts` MAPPING_RULES（与 152 RPC 逐行等价） |
| auto 角色写入防橡皮擦 / drift 翻转 manual | `thin-sync/manifest.ts` actionAssignRoles |
| 离职四 sink | `thin-sync/manifest.ts` actionDisable（disable + casdoor_writer + token_blacklist 7 天） |
| 能力单真相：7 看板 + 6 KPI 卡 | `web/lib/capability-board.ts` BOARD_CAPABILITIES / KPI_CARD_CAPABILITIES |
| 能力 catalog 单真相（view/brand/category/field/admin） | `web/lib/capability-catalog.ts`（manual + generated；空集=deny，禁 ["*"]） |
| 管理台判定 | `web/lib/admin-api-auth.ts` requireAdmin → `checkFeaturePerm(uid,'data-analysis:admin')`（token permissions 优先 + BREAKGLASS_ADMINS env 兜底） |
| claims 组装（可达对象并集 → permissions；data_scope 空段=deny；groups=OIDC 原生） | `functions/wecom-oidc-callback/claims.js` |
| 例外通道 | `permission-maintenance.md` / `GET|POST|DELETE /api/admin/permissions/grants`（≤50 条、≤90 天；撤销 ≤5min） |
| 验证命令 | `SELECT * FROM get_user_perms('<工号>');`、`GET /api/admin/permissions/preview?wecom_id=<工号>` |

## 六、边界（明确不在本文档范围）

- **不改任何代码 / 权限配置**：纯文档交付，不改 Casdoor 配置、不改 RLS、不改同步逻辑
- 不覆盖 Casdoor 组织/应用/OIDC Provider 的 IaC 初始化（属部署交付物，本手册起点 = 它们已就绪）
- 不重复三份既有文档的模型/边界/机制内容，只引用

## 七、后续工作（实现阶段）

1. 按 §四 重写 `docs/ops/permission-onboarding.md`（v2 结构；v1 已提交的 4 个 commit 内容：初始化部分新写，单人开通/收权收敛进 §7，附录重排 A-D）
2. 更新实现计划为 v2 分块，逐块提交
3. 终审：事实锚点逐字核对；【截图位】与附录 C 行数一致；互链全部可解析；只改 markdown
4. 用户审阅后提交；截图由用户日后按附录 C 补齐