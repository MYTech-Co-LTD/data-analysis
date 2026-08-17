# 权限开通操作手册（新员工入职 / 离职转岗收权）

> 成文 2026-08-17。给运维/管理员本人：给一个人从头配置权限的逐步操作手册。
> 模型总览 / 职责边界 / Casdoor 机制分别见
> [permission-maintenance.md](./permission-maintenance.md) ·
> [permission-boundary.md](./permission-boundary.md) ·
> [casdoor-role-permission-mechanism.md](./casdoor-role-permission-mechanism.md)。
> 设计文档：`docs/superpowers/specs/2026-08-17-permission-onboarding-design.md`。

> ⚠️ **大多数新人到「第 2 步」就完事**——部门名默认推导 `manager`，数据范围随组/角色
> 自动带出；只有特殊职位 / 特殊范围 / 临时收窄才需要走 3-5 步。

## 0. 一句话流程 + 开局速查

> 企微加人 → 通讯录同步 → 薄同步 JIT 建户挂组 → 角色(自动/手动) → 例外(可选) → 验证

| 步骤 | 做什么 | 去哪个系统 | 什么人需要走 |
|---|---|---|---|
| 1 | 确认人已入企微并同步 | 企微后台 + 本系统（curl 触发同步） | 所有人 |
| 2 | 核对 Casdoor 自动建户 + 挂组 | Casdoor 控制台 | 所有人（核对即可） |
| 3 | 确认 / 修改角色 | Casdoor 角色页（自动推导多数不用动） | 部门名推导不符时 |
| 4 | 配数据范围（门店/品牌品类/成本） | Casdoor 组/权限，一般自动成立 | 特殊范围时 |
| 5 | 临时例外 | 本系统 `/admin/permissions`「例外」 | 临时放开/收窄时 |
| 6 | 验证三步 | 本系统 + 登录看板 | 所有人 |
| 7 | 离职 / 转岗收权 | 企微 + 本系统例外撤销 | 离职/转岗时 |

## 1. 确认人已入企微并同步

新员工源头是企微通讯录，平台的用户/部门数据都由它同步。

1. **企微后台加人**（源操作，不在平台内）：企微管理后台 → 通讯录 → 添加成员。
2. **触发同步**。每日 03:17 有自动全量兜底，但新入职加班等不到，手动触发：
   ```bash
   curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
   ```
3. **核对已入 org_users**：
   ```sql
   SELECT wecom_id,name,department_ids,is_active FROM org_users WHERE wecom_id='<工号>';
   -- name=中文名、department_ids 非空 → 同步成功
   ```

【截图位】通讯录同步结果 / org_users 查询结果

## 2. 核对 Casdoor 自动建户 + 挂组（JIT 结果）

薄同步每 30 分钟自动扫一遍（`*/30 * * * *`）：新用户自动在 Casdoor 建户
（`name`=工号、`displayName`=企微中文名，并挂上部门组），**无手动触发**，等下一轮薄同步即可。

1. 核对途径一（Casdoor 控制台）：组织管理入口 `https://sso.shanhaiyiguo.com/login/shanhai`
   进入（⚠️ 默认 `/login` 是 built-in 全局管理员登录页，组织管理员在那里登不进）→
   用户列表 → 按工号（name）搜索。
2. 核对途径二（API）：
   `GET https://sso.shanhaiyiguo.com/api/get-user?id=shanhai/<工号>`

**异常**：非法用户名（如 `YiBeiMeiShi.` 带点号）会被 Casdoor 拒建 → 薄同步失败入 outbox →
需企微侧修正 userid 后同步自愈；排查：
```bash
docker logs deploy-web-1 --since 48h 2>&1 | grep -iE "provision|outbox"
```

【截图位】Casdoor 用户列表搜索产物

## 3. 角色：确认 / 修改

**自动推导（多数人跳过此步）**：薄同步按部门名自动推导角色并已写进 Casdoor Role.Users——
推导结果即想要的角色时**什么都不用做**，第 3 步直接跳过。推导规则（`web/lib/sync/derive-roles.ts`，
与 152 迁移 `refresh_role_assignments` 逐行等价）：

| 部门名含 | 角色码 | 档位 |
|---|---|---|
| 总经办 / 运营总 / 老板 | boss | full（含成本） |
| 战区 / 区域 / 大区 | zone_manager | full（含成本） |
| 店长 / 门店 | manager | basic（不含成本） |
| 采购 / 业务 / 品类 | buyer | basic（不含成本） |
| 财务 | finance | full（含成本） |
| 无匹配 | manager（默认） | basic |

**推导不符要改角色**：Casdoor → 控制台 → 组织管理入口
（`https://sso.shanhaiyiguo.com/login/shanhai`）→ **Roles** → 目标角色 → **Sub users** → 加人。

- ⚠️ **Sub users 下拉只显示「工号」**（Casdoor 前端写死只渲染 `owner/name`，中文名永远不出现，
  非配置项）。认人请对照本系统 `/admin/permissions` 用户列表（中文名 + 工号两列），别靠猜。
- **覆盖规则（防橡皮擦）**：本系统 `role_codes` 镜像里含推导码之外的「附加角色」时，
  薄同步会**跳过写入**，交给 drift 对比后把该用户翻成 `manual` 保护——
  手动改过的角色在后续轮询里不会被打回默认推导。
- 推导/手动归属口径详见 `casdoor-role-permission-mechanism.md` §二（Role.Users 权威）。

【截图位】Casdoor 角色页 Sub users 编辑态

## 4. 数据范围：门店 / 品牌品类 / 成本

数据范围是「怎么走」的，一般随第 2 步自动成立，第 4 步多数人只需**确认挂对了组**：

- **门店 = 组挂载**：用户所在 Casdoor Group（部门组，由企微部门树自动同步）→ groups claim →
  `data_scope.branch_nums` → RLS 行过滤。一般随组织架构自动成立；
  异常补挂：Casdoor → 组织架构 → 目标组 → 编辑成员。
- **品牌 / 品类 / 成本 = 角色内置**：5 个角色 permission 已按档位配好
  ——full 档 3 角色（boss / zone_manager / finance）含 `field:cost`，
  basic 档 2 角色（manager / buyer）不含。**一般不用手动勾**。
- ⚠️ 只在**收窄 / 特殊放开**时才去动 Casdoor permission 的 Resources——
  那时**必须整字段 update 或直接删建**，禁止点加字段局部保存
  （会按 AllCols 生成的空字段把权限洗白，教训见 `casdoor-role-permission-mechanism.md` §3.3）。

【截图位】Casdoor permission Resources 列表 / 组编辑成员

## 5. 临时例外（本系统唯一权限写入口）

常规权限（角色/组）都走 Casdoor；**本系统 `/admin/permissions` 的「例外」tab 是唯一的权限写入口**，
只做临时放开 / 临时收窄：

- 页面：本系统 `/admin/permissions` →「例外」tab（管理员登录）
- 维度与限制：门店（`branch_number` 复合键，形如 `3120-0027`）/ 品牌（`system_book_code`）/
  品类 / 字段 cost；单维 ≤50 条、到期 ≤90 天
- 生效：RLS 每请求实查，**即时生效 / 即时收口**（撤销 ≤5min 生效）
- API 形式（管理员脚本用）：`POST/DELETE /api/admin/permissions/grants`；审计 `GET .../audit`

【截图位】例外 tab 授权表单

## 6. 验证三步（每次配完必做）

1. **DB 视角（合成）**：
   ```sql
   SELECT * FROM get_user_perms('<工号>');
   ```
   看角色、`data_scope.branch_nums`、`fields.cost` 各段是否符合预期。
2. **claims 视角（管理员预览）**：
   `GET /api/admin/permissions/preview?wecom_id=<工号>`
   看 groups / data_scope / fields.cost 各段——是「新开会话将拿到的 claims」。
3. **真实会话视角**：退出登录、重新登录实际看板，确认门店行范围 / 成本列掩码 / 看板卡片可见性。

三步口径不一致时见附录 C 排障跳转。

【截图位】preview 响应 / 看板实际可见

## 7. 离职 / 转岗收权

**离职（源操作在企微，软删除）**：
1. 企微后台停用 / 删除该用户
2. 通讯录同步（§1 手动触发或每日 03:17 兜底）写 `is_active=false`
3. 薄同步 **actionDisable**（≤30min）四连收权：
   Casdoor disable + 本系统标记 `casdoor_writer='disabled'` +
   `token_blacklist` 拉黑（7 天窗口内的旧 JWT 即刻拒绝）→ outbox 计数重试直到成功
4. 核对：
   ```sql
   SELECT wecom_id,casdoor_writer,is_active FROM org_users WHERE wecom_id='<工号>';
   -- casdoor_writer='disabled' 且 Casdoor 用户状态为禁用 → 收权完成
   ```

**转岗换角色**：改部门（企微 + 同步）→ 薄同步按新部门**重新推导角色并写 Casdoor**；
无附加角色时旧角色自动摘除（有附加角色则受 §3 覆盖规则保护，需手动清）。

**例外回收**：`/admin/permissions`「例外」撤销（到期自动失效，无需手动）。

【截图位】例外撤销 / 离职用户状态

---

## 附录 A：5 角色速查表

| 角色码 | 档位 | cost 字段 | 典型人群（部门名推导） | 手册对应步骤 |
|---|---|---|---|---|
| boss | full | 含 | 总经办 / 运营总 / 老板 | §2 自动挂载 → §3 确认 |
| zone_manager | full | 含 | 战区 / 区域 / 大区 | §2 自动挂载 → §3 确认 |
| manager | basic | 不含 | 店长 / 门店（无匹配默认） | §2 自动挂载 → §3 确认 |
| buyer | basic | 不含 | 采购 / 业务 / 品类 | §2 自动挂载 → §3 确认 |
| finance | full | 含 | 财务 | §2 自动挂载 → §3 确认 |

推导规则 = 部门名正则匹配（见 §3 表）；多数人自动推导即目标，无需动手。

## 附录 B：截图落位表

> 截图由管理员日后按本表补齐；正文各步的 `【截图位】` 即对应下表的行，补完贴到 `docs/ops/screenshots/` 并把正文标记替换为图片。

| 正文步骤 | 截哪个界面 | 圈哪里 | 建议文件名 |
|---|---|---|---|
| §1 同步 | 通讯录同步触发结果（curl 回显）+ org_users 查询结果 | 同步成功返回 / name、department_ids 非空 | `01-sync-result.png` |
| §2 JIT 建户 | Casdoor 用户列表（按工号搜索） | 新用户的 name / displayName / 所属组 | `02-casdoor-user.png` |
| §3 角色 | Casdoor 角色页 Sub users 编辑态 | 下拉里只有工号；目标角色加人后列表 | `03-role-subusers.png` |
| §4 数据范围 | Casdoor permission Resources 列表 / 组编辑成员 | full/basic 档 resources 差异；组下成员 | `04-permission-resources.png` |
| §5 例外 | 本系统 `/admin/permissions` 例外 tab 授权表单 | 维度选择 / 期限 / 提交 | `05-exception-form.png` |
| §6 验证 | preview 响应 / 登录实际看板 | groups、data_scope、fields.cost 各段；门店行 / 成本掩码 | `06-preview-and-dashboard.png` |
| §7 收权 | 例外撤销 / 离职用户状态 | 撤销成功提示；casdoor_writer 状态 | `07-offboard.png` |

## 附录 C：排障跳转

| 症状 | 先看 | 跳转 |
|---|---|---|
| Casdoor 无户 / 拒建 | `docker logs deploy-web-1 --since 48h 2>&1 \| grep -iE "provision\|outbox"` | §2 异常例（非法用户名）|
| 角色推导 vs 手动不一致 | `SELECT wecom_id,role_codes,casdoor_writer FROM org_users WHERE wecom_id='<工号>';` 看 `role_source` | §3 覆盖规则（手动角色受保护）|
| 门店范围 / 成本列不对 | `SELECT * FROM get_user_perms('<工号>');` 逐段判断 groups ↔ branch_nums ↔ fields | §4（组挂载 / 角色档位）|
| get_user_perms 与 preview 不一致 | 重开会话再试（缓存/会话残留） | §5/§6（例外即时收口 ≤5min）|