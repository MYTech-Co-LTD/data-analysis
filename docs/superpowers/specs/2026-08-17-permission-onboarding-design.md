# 权限开通操作手册设计（新人入职/离职收权）

> 成文 2026-08-17。状态：设计已确认（结构 A 主线流程式 + 收权小节 + 附录 B 截图落位表）。

## 一、背景与目标

平台权限 2026-08-17 标准化后（Casdoor = 管理面真相源，data-analysis = 执行面），
权限模型已理顺，但**缺一份「照着点」的实操手册**：现有三份文档分别讲模型、边界、机制，
没有一份把「给一个人从头配好权限」的步骤按顺序走一遍，新同事入职时管理员要靠文件+代码现场拼凑。

**目标**：一份给运维/管理员本人的**主线流程式操作手册**——从头到尾给一个人配置权限的每一步：
去哪、点哪、填什么、怎么验证。先文字版交付，截图以后按落位表补齐。

## 二、现状文档格局（新手册的定位）

| 文档 | 讲什么 | 新手册关系 |
|---|---|---|
| `docs/ops/permission-maintenance.md`（2026-08-17 模型总览） | 模型表 + 例外通道 + 看板能力 + 排障命令 | 互链：新手册把它当「模型参考」引用 |
| `docs/ops/permission-boundary.md` | 职责边界（三层职责 + 合成顺序 + 实操表） | 互链：边界不清时引用 |
| `docs/ops/casdoor-role-permission-mechanism.md` | Casdoor 角色/权限源码级机制 + 落地方案 | 互链：机制疑点引用 |
| `docs/ops/permission-onboarding.md`（**新建，本文档的交付物**） | **逐步操作手册（新人开通/收权）** | 文首互链上述三份 |

## 三、手册定位参数

- **受众**：运维/管理员本人（懂系统术语，不需要科普；步骤细到可照抄命令）
- **形态**：全文字版 + 每步「截图落位」标注（附录 B 汇总）；日后按落位表补真图
- **存放**：`docs/ops/permission-onboarding.md`（与其它权限文档同目录，天然按模型/边界/机制/操作四件套互链）
- **范围**：入职开通主线 + 离职/转岗收权小节；不含历史 legacy（data_permissions 四维）已下线内容

## 四、手册结构（章节大纲 = 交付物骨架）

### 0. 一句话流程 + 开局速查
> 企微加人 → 通讯录同步 → 薄同步 JIT 建户挂组 → 角色(自动/手动) → 例外(可选) → 验证
- **关键提示**：大多数新人到「第 2 步」就完事（部门名默认推导 `manager`，数据范围随组/角色自动带出），
  只有特殊职位 / 特殊范围 / 临时收窄才需要走 3-5 步。手册按「闰路筛掉再深入」组织。

### 1. 确认人已入企微并同步
- 企微后台加人（源操作，不在平台内）
- 手动触发通讯录同步：`curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts`
  （另：每日 03:17 有自动全量兜底，`contact-sync/manifest.ts`）
- 核对 org_users：SQL
  ```sql
  SELECT wecom_id,name,department_ids,is_active FROM org_users WHERE wecom_id='<工号>';
  -- name=中文名、department_ids 非空 → 同步成功
  ```
- 【截图位】通讯录同步结果 / org_users 查询结果

### 2. 核对 Casdoor 自动建户 + 挂组（JIT 结果）
- 薄同步每 30 分钟自动扫一遍（`thin-sync/manifest.ts` schedule `*/30 * * * *`）：新用户自动
  `provisionUser` → Casdoor 建户（`name`=工号、`displayName`=企微中文名、挂部门组）+ `syncUserGroups`
- 无手动触发；等下一轮薄同步即可
- 核对：Casdoor 控制台用户列表搜索 `name`（工号）；或
  `GET https://sso.shanhaiyiguo.com/api/get-user?id=shanhai/<工号>`
- 异常：`YiBeiMeiShi.` 这类非法用户名（带点号）会被 Casdoor 拒建 → 薄同步失败入 outbox →
  需企微侧修正 userid 后同步自愈；以 `docker logs` grep provision/outbox 排查
- 【截图位】Casdoor 用户列表搜索产物

### 3. 角色：确认 / 修改
- **自动推导**（`derive-roles.ts` / 152 RPC 同源）：部门名正则 → 角色码

  | 部门名含 | 角色码 | 档位 |
  |---|---|---|
  | 总经办 / 运营总 / 老板 | boss | full（含成本） |
  | 战区 / 区域 / 大区 | zone_manager | full（含成本） |
  | 店长 / 门店 | manager | basic（不含成本） |
  | 采购 / 业务 / 品类 | buyer | basic（不含成本） |
  | 财务 | finance | full（含成本） |
  | 无匹配 | manager（默认） | basic |
- **多数人跳过此步**：推导结果即想要的角色时什么都不用做（薄同步已自动写 Casdoor Role.Users）
- **要改角色**：Casdoor → 控制台 → 组织管理入口 → Roles → 目标角色 → **Sub users** → 加人
  - ⚠️ 下拉框只显示 `工号`（Casdoor 前端写死，见 `casdoor-role-permission-mechanism.md` §二/角色页）；
    认人对照本系统 `/admin/permissions` 用户列表（中文名 + 工号）
  - **覆盖规则**：本地 `role_codes` 镜像含推导码之外的附加角色 → 薄同步**跳过写入**（防橡皮擦），
    交给 drift 翻转 `manual` 保护——手动改过的角色轮询不会被打回
- 【截图位】Casdoor 角色页 Sub users 编辑态

### 4. 数据范围：门店 / 品牌品类 / 成本
- **门店范围 = 组挂载**：用户所在 Casdoor Group（部门组，企微部门树自动同步）→ groups claim →
  `data_scope.branch_nums` → RLS 行过滤。一般随组织架构自动成立；确认用户挂在正确组即可
  - 异常补挂：Casdoor → 组织架构 → 目标组 → 编辑成员
- **品牌 / 品类 / 成本 = 角色内置**：5 角色 permission（role-*）已按 D1/D2 配置，
  full 档 3 角色（boss/zone_manager/finance）含 `field:cost`，basic 档 2 角色（manager/buyer）不含。
  **一般不用手动勾**；只在收窄或特殊放开时才动 Casdoor permission 的 Resources
  （务必整字段 update / 或删建，防 AllCols 清空——见 `casdoor-role-permission-mechanism.md` §3.3 教训）
- 【截图位】Casdoor 角色 permission 的 Resources 列表 / 组编辑成员

### 5. 临时例外（本系统唯一权限写入口）
- 页面：`/admin/permissions` → 「例外」tab（管理员）
  - 维度：门店（branch_number 复合键，如 `3120-0027`）/ 品牌（system_book_code）/ 品类 / 字段 cost
  - 限制：单维 ≤50 条、到期 ≤90 天
- 生效：RLS 每请求实查，**即时生效 / 即时收口**（撤销 ≤5min 生效）
- API 形式：`POST/DELETE /api/admin/permissions/grants`；审计 `GET .../audit`
- 【截图位】例外 tab 授权表单

### 6. 验证三步
1. SQL：`SELECT * FROM get_user_perms('<工号>');` —— 合成后权限（DB 视角）
2. 本系统预览：`GET /api/admin/permissions/preview?wecom_id=<工号>`（管理员）——
   groups / data_scope / fields.cost 各段
3. 登录实际看板：新开会话验证可见范围（门店行 / 成本列掩码 / 看板卡片）
- 【截图位】preview 响应 / 看板实际可见

### 7. 离职 / 转岗收权
- **离职（软删除源）**：企微停用/删除该用户 → 通讯录同步写 `is_active=false` →
  薄同步 actionDisable（≤30min）：Casdoor disable + `casdoor_writer='disabled'` +
  `token_blacklist` 拉黑（7 天窗口内旧 JWT 即刻拒）→ outbox 计数重试
- **转岗换角色**：改部门 → 同步更新 department_ids → 薄同步按新部门重新推导角色并写 Casdoor；
  原角色自动摘除（无附加角色时）
- **例外回收**：`/admin/permissions`「例外」撤销（到期自动失效，无需手动）
- 核对：`SELECT wecom_id,casdoor_writer,is_active FROM org_users WHERE wecom_id='<工号>';`
  与 Casdoor 用户状态一致
- 【截图位】例外撤销 / 离职用户状态

## 附录
- **A. 5 角色速查表**：角色码 ↔ 档位（cost 有/无）↔ 典型人群 ↔ 手册中对应的步骤
- **B. 截图落位表**：逐步骤「截哪个界面 → 圈哪里 → 建议文件名」（主正文每步已内联【截图位】，
  此处汇总成补图工作清单）
- **C. 排障跳转**：身份（Casdoor 无户/拒建）→ 角色（derive 推导 vs 手动）→ 范围（组挂载/RLS）→
  例外（preview 与 get_user_perms 对比）→ 各自指向既有命令

## 五、真实链路事实锚点（均已核对代码，2026-08-17）

| 事实 | 依据 |
|---|---|
| 薄同步每 30 分钟 | `web/lib/jobs/thin-sync/manifest.ts:225`（`*/30 * * * *`） |
| 通讯录全量兜底 03:17 | `web/lib/jobs/contact-sync/manifest.ts:17` |
| 手动触发同步 | `POST /functions/wecom-sync-contacts`（CLAUDE.md 部署/测试节） |
| JIT 建户带 displayName | `web/lib/sync/casdoor-client.ts:128-140`（provisionUser） |
| auto 角色写入防橡皮擦 | `thin-sync/manifest.ts` actionAssignRoles（extra 角色 → skip → drift 翻转 manual） |
| 离职四 sink | `thin-sync/manifest.ts` actionDisable（disable + 标记 + token_blacklist） |
| 例外通道 | `permission-maintenance.md` / `GET|POST|DELETE /api/admin/permissions/grants` |
| 角色推导表 | `web/lib/sync/derive-roles.ts` MAPPING_RULES（与 152 RPC 逐行等价） |

## 六、边界（明确不在本文档范围）

- **不改任何代码 / 权限配置**：纯文档交付，不改 Casdoor permission、不改 RLS、不改同步逻辑
- 不覆盖 legacy `data_permissions` 四维时期的操作（已下线，文档明确标注禁止再引用）
- 不重复三份既有文档的模型/边界/机制内容，只引用

## 七、后续工作（实现阶段）

1. 按 §四 章节写 `docs/ops/permission-onboarding.md` 全文
2. 附录 A/B/C 落齐
3. 文首互链三份既有文档 + 三份文档补「引向 onboarding 手册」的反向互链
4. 用户审阅后提交；截图由用户日后按附录 B 补齐