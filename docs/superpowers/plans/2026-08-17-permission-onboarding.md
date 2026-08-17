# 权限体系配置手册实现计划（v2：管理员空系统初始化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 `docs/ops/permission-onboarding.md` 为管理员视角的「空系统初始化权限体系 + 日常维护」操作手册（v1 单人开通流程收敛为 §7），并在三份既有文档微调反链文案。

**Architecture:** 纯文档交付，不改任何代码/权限配置。按设计 v2「0 前置 → 1 建角色 → 2 建权限 → 3 用户进角色 → 4 管理台 → 5 数据范围 → 6 例外 → 7 日常运维 + 附录 A-D」组织；控制台 UI 为主、关键步附 API 备选；角色模板照抄 5 角色模型。事实锚点一律取设计 v2 §五（已核对代码，禁止实现者现场重查改值）。

**Tech Stack:** Markdown（`docs/ops/` 同一文风：`# 标题` + `> 日期/定位说明` blockquote + 表格 + 可抄命令 + UI 路径）。

## Global Constraints

- 文档正文语言：中文。与 `docs/ops/permission-maintenance.md` / `permission-boundary.md` / `casdoor-role-permission-mechanism.md` 同风格。
- **不改任何代码**：不碰 `web/`、`functions/`、`database/`、Casdoor 配置。只改 `docs/` 下 markdown。
- 事实锚点（照抄设计 v2 §五，禁止改值）：
  - 初始化顺序（事务化）：先建 5 角色 + 挂人 → 再建 5 permission 绑 Roles → 验证全等 → 清 Users 双保险（机制文档 §3.3/§3.4）
  - 挂 Role.Users 必须 `update-role` 全量（add-role-for-user 404）
  - 薄同步 `*/30 * * * *`；通讯录兜底每日 03:17；手动触发 `curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts`
  - Casdoor 组织管理入口 `https://sso.shanhaiyiguo.com/login/shanhai`（默认 `/login` 是 built-in 管理员页）
  - 角色模板：boss/zone_manager/finance=full 含 cost；manager/buyer=basic 不含（derive-roles.ts 与 152 逐行等价）
  - 管理台：`data-analysis:admin` 手动授（token claims 优先 + BREAKGLASS_ADMINS env 兜底）
  - 能力单真相：7 看板（view-board:*）+ 6 KPI 卡（view-kpi:*）+ 4 视图（view:reports*）+ brand:3120/64188 + category:水果/标品/耗材 + field:cost + admin（capability-board.ts / capability-catalog.ts；空集=deny 禁 ["*"]）
  - claims 三段：permissions=可达对象并集资源串；data_scope 空段=deny；groups=OIDC 原生全路径（claims.js）
  - 验证：`SELECT * FROM get_user_perms('<工号>');`、`GET /api/admin/permissions/preview?wecom_id=<工号>`
  - 例外：`POST/DELETE /api/admin/permissions/grants`，≤50 条/维、≤90 天，撤销 ≤5min
  - 离职四 sink：Casdoor disable + `casdoor_writer='disabled'` + token_blacklist 7 天
- 三份既有文档反链文案微调：「逐步操作（新人开通/收权）」→「权限体系配置（初始化/维护）」；文件名不变，链接仍指 `./permission-onboarding.md`。

---

### Task 1: 重写首部 + §0 一句话流程/速查 + §1 前置条件 + §2 建 5 角色

**Files:**
- Rewrite: `docs/ops/permission-onboarding.md`（v1 全文替换为 v2 首部 ~1-90 行）

**Interfaces:**
- Consumes: 设计 v2 §三（定位参数：UI 为主/5 角色模板）、§四 §0-§2、§五 锚点
- Produces: v2 标题 + blockquote（互链三份 + 设计文档）+ §0 + §1 + §2；后续任务追加

- [ ] **Step 1: 重写标题 + 定位 blockquote**

标题：`# 权限体系配置手册（管理员从空系统初始化与日常维护）`。blockquote 沿用 v1 文风：
成文日期、给管理员本人、互链 permission-maintenance/boundary/casdoor-role-permission-mechanism +
设计文档路径。加一句「起点 = 组织架构已同步、Casdoor 组织/应用就绪、Roles/Permissions 全空」。

- [ ] **Step 2: 写 §0 一句话流程 + 开局速查**

一句话（照抄设计）：`前置就绪 → 建 5 角色 → 建 5 权限 → 用户进角色（薄同步 auto）→ 管理台账号 → 数据范围确认 → 例外(可选) → 验证`。
速查表：步骤 | 做什么 | 去哪个系统 | 首次初始化是否必需（1-5 必需 / 6-7 按需）。

- [ ] **Step 3: 写 §1 前置条件确认**

- SQL `SELECT count(*) FROM org_users;` 非空 + 组织管理入口可登录（URL + ⚠️ /login 坑）
- 明确「Roles 列表为空、Permissions 列表为空 = 正确起点」
- 异常例沿用 v1 §2 非法用户名拒建（YiBeiMeiShi. → outbox）——移到附录 D
- 【截图位】组织架构查询 / Casdoor Roles 空列表

- [ ] **Step 4: 写 §2 建 5 角色**

- 控制台路径：组织管理入口 → Roles → 逐一添加 boss/zone_manager/finance/manager/buyer
- ⚠️ 名必须与模板逐字一致（薄同步按名/推导码写入）；档位对照附录 A
- API 备选：`add-role`（owner=shanhai、name）；注明「add-role-for-user 不存在（404），后续挂人只能 update-role」
- 【截图位】Roles 添加页

- [ ] **Step 5: 终审本块 + Commit**

命令/事实逐字对照 Global Constraints；角色名与 derive-roles 码一致。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限配置手册v2—定位/速览/前置/建角色"
```

---

### Task 2: §3 建 5 权限 + §4 用户进角色 + §5 管理台账号

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§2 后追加）

**Interfaces:**
- Consumes: Global Constraints 能力单真相 / 管理台判定；机制文档 §3.4 事务化顺序
- Produces: §3、§4、§5

- [ ] **Step 1: 写 §3 建 5 权限（role-*）**

- 控制台：Permissions → 添加 5 个；每个 **Roles 绑对应角色** + **Resources 勾附录 B 能力**（full 档含 `data-analysis:field:cost`）
- ⚠️ 事务化顺序（机制 §3.4）：建角色+挂人 → 后建 permission；禁先清 Users
- ⚠️ 编辑须知：改 Resources 整表单提交（UI 天然整表单）；API 局部 PATCH = AllCols 清空（指附录 D）
- API 备选：`add-permission`（触发 addPolicies；直接 DB INSERT 不生效，机制 §五 验证矩阵）
- 【截图位】Permissions 添加页 / Resources 勾选态

- [ ] **Step 2: 写 §4 用户进角色**

- 自动：薄同步 30 分钟按派生规则写 Role.Users（§2 建好 Rolle 定义后自动开跑）
- 存量补挂：Roles → Sub users → 加人（或 API update-role 全量）；多部门取 priority 最高
- ⚠️ UI 下拉只显示工号（前端写死 owner/name 渲染），认人对照本系统 `/admin/permissions`（中文名+工号）
- 覆盖规则：镜像含额外角色 → 薄同步跳过（防橡皮擦）→ drift 翻转 manual
- 【截图位】Sub users 编辑态

- [ ] **Step 3: 写 §5 管理台账号**

- 判定链：`checkFeaturePerm(uid,'data-analysis:admin')`——token claims permissions 命中 或 BREAKGLASS_ADMINS env 兜底
- 授权：Casdoor permission Resources 加 `data-analysis:admin`（绑定运维专用账号/角色，建议不兼任业务角色）
- 【截图位】admin 能力勾选

- [ ] **Step 4: 校验 + Commit**

角色↔permission 一一对应；full/basic 档位与 Global Constraints 一致。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限配置手册v2—建权限/用户进角色/管理台"
```

---

### Task 3: §6 数据范围 + §7 日常运维（单人开通/转岗/离职收敛）

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§5 后追加）

**Interfaces:**
- Consumes: v1 已核对事实（§1-§7 v1 内容收缩为单人开通/收权操作）；Global Constraints 验证/例外/离职命令
- Produces: §6、§7

- [ ] **Step 1: 写 §6 数据范围确认**

门店=组挂载（groups claim → data_scope.branch_nums → RLS）；品牌/品类/成本=角色档位；收窄才动 Resources（整表单/删建，防 AllCols）。
【截图位】permission Resources 列表 / 组编辑成员

- [ ] **Step 2: 写 §7 日常运维**

- **单人开通**：企微加人 → `curl -s -X POST .../wecom-sync-contacts` → 薄同步 JIT（displayName=中文名，≤30min）→ 角色自动推导 → 验证三步
- **验证三步**：`get_user_perms` / `preview?wecom_id=` / 实登看板
- **转岗**：改部门 → 重推导写 Casdoor；无附加角色自动摘除
- **离职**：企微停用 → 同步 is_active=false → actionDisable 四 sink（Casdoor disable + casdoor_writer='disabled' + token_blacklist 7 天）；核对 SQL
- **例外回收**：例外 tab 撤销（到期自动失效）
- 【截图位】preview 响应 / 看板实际可见 / 例外撤销 / 离职用户状态

- [ ] **Step 3: 校验一致 + Commit**

v1 已验证的命令/事实原样保留，不重写不刷新。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限配置手册v2—数据范围/日常运维"
```

---

### Task 4: 附录 A-D + 三文档反链文案微调 + 终审

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§7 后追加附录）
- Modify: `docs/ops/permission-maintenance.md`（反链文案微调）
- Modify: `docs/ops/permission-boundary.md`（反链文案微调）
- Modify: `docs/ops/casdoor-role-permission-mechanism.md`（反链文案微调）

**Interfaces:**
- Consumes: 全文内联【截图位】；Global Constraints 能力清单
- Produces: 附录 A/B/C/D；三文档反链文案更新

- [ ] **Step 1: 附录 A 角色/权限速查表**

列：角色码 | 档位 | cost | 派生来源（部门名）| 对应 permission | 管理台。boss/zone_manager/finance=full 含 cost；manager/buyer=basic；admin 单独列。数据照抄设计 v2 §三/Global Constraints。

- [ ] **Step 2: 附录 B 能力清单（Resources 勾选依据）**

7 看板（view-board:* 对应 BOARD_CAPABILITIES 名称）+ 6 KPI 卡（view-kpi:*）+ 4 视图 view:reports* + brand:3120/64188 + category:水果/标品/耗材 + field:cost + admin。注明单真相位置（capability-board.ts / capability-catalog.ts）与「新增看板/卡片按单真相同步，本表是快照」。

- [ ] **Step 3: 附录 C 截图落位表 + 附录 D 排障与坑**

C：汇总全文【截图位】（步骤 | 截哪个界面 | 圈哪里 | 建议文件名）。D：身份（拒建/outbox）、角色（auto vs manual）、范围（preview vs get_user_perms）、Permissions 页空白（update-permission AllCols → actions null.map，机制 §3.3 教训）、exception 即时收口 ≤5min。

- [ ] **Step 4: 三文档反链文案微调**

三处「> 逐步操作（新人开通/收权）：[permission-onboarding.md](./permission-onboarding.md)。」→
「> 权限体系配置（初始化/维护）：[permission-onboarding.md](./permission-onboarding.md)。」。

- [ ] **Step 5: 终审 + Commit**

终审：① 无 TBD/待补空洞；② 【截图位】数 = 附录 C 行数；③ 互链相对路径全部可解析；④ 命令与 Global Constraints 逐字一致；⑤ 未改动任何非 markdown 文件。

```bash
git add docs/ops/
git commit -m "docs(perm): 权限配置手册v2—附录速查/能力清单/落位/排障+反链文案"
```

---

## Self-Review 记录（v2 重写计划自查）

- **Spec coverage（设计 v2 §四→本计划）**：§0→T1-S2 ✓；§1→T1-S3 ✓；§2→T1-S4 ✓；§3→T2-S1 ✓；§4→T2-S2 ✓；§5→T2-S3 ✓；§6→T3-S1 ✓；§7→T3-S2 ✓；附录 A/B/C/D→T4-S1/2/3 ✓；三文档反链文案→T4-S4 ✓；设计 §六 边界（不改代码）→Global Constraints ✓。
- **Placeholder scan**：各步骤给 UI 路径/命令/要点；附录 B 数据引用单真相文件而非内嵌全量（避免与 catalog 漂移）。
- **Type/一致性**：角色名与 derive-roles 码一致；permission 名 role-* 与机制文档 §3.3 一致；命令串与 v1 已核对值一致（wecom-sync-contacts / get_user_perms / preview / grants）。