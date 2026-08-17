# 权限开通操作手册实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `docs/ops/permission-onboarding.md`——给运维本人的「给一个人从头配权限」逐步操作手册（主线流程式 + 收权小节 + 附录 A/B/C），并在三份既有权限文档追加反向互链。

**Architecture:** 纯文档交付，不改任何代码/权限配置。手册按已确认设计「0 一句话流程 → 1 同步 → 2 JIT 核对 → 3 角色 → 4 数据范围 → 5 例外 → 6 验证 → 7 收权 + 附录 A 角色速查 / B 截图落位 / C 排障跳转」组织；每步内联【截图位】标注。事实锚点一律取自设计文档 §五（均已核对代码，禁止实现者现场重查改值）。

**Tech Stack:** Markdown（与 `docs/ops/` 现有文档同一文风：`# 标题` + `> 日期/定位说明` blockquote + 表格 + 可抄命令）。

## Global Constraints

- 文档正文语言：中文。与 `docs/ops/permission-maintenance.md` / `permission-boundary.md` / `casdoor-role-permission-mechanism.md` 同风格（标题、blockquote、表格、代码块命令）。
- **不改任何代码**：不碰 `web/`、`functions/`、`database/`、Casdoor 配置。只新建/编辑 `docs/` 下 markdown。
- 事实锚点（来自设计文档 §五，已核对代码，照抄）：
  - 薄同步每 30 分钟自动跑：`*/30 * * * *`（`web/lib/jobs/thin-sync/manifest.ts:225`）
  - 通讯录全量兜底每日 03:17：`17 3 * * *`（`web/lib/jobs/contact-sync/manifest.ts:17`）
  - 手动触发同步：`curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts`
  - Casdoor 组织管理入口：`https://sso.shanhaiyiguo.com/login/shanhai`（URL 已 pin 组织；默认 `/login` 是 built-in 管理员登录页，组织管理员登不进）
  - 验证命令：`SELECT * FROM get_user_perms('<工号>');`、`GET /api/admin/permissions/preview?wecom_id=<工号>`
  - 例外 API：`POST/DELETE /api/admin/permissions/grants`；审计 `GET .../audit`
- 角色推导表（`web/lib/sync/derive-roles.ts` MAPPING_RULES，与 152 RPC 逐行等价）：

  | 部门名含 | 角色码 | 档位 |
  |---|---|---|
  | 总经办 / 运营总 / 老板 | boss | full（含成本） |
  | 战区 / 区域 / 大区 | zone_manager | full（含成本） |
  | 店长 / 门店 | manager | basic（不含成本） |
  | 采购 / 业务 / 品类 | buyer | basic（不含成本） |
  | 财务 | finance | full（含成本） |
  | 无匹配 | manager（默认） | basic |

---

### Task 1: 文档骨架 + 引言互链 + 第 0~2 步（流程速览 / 同步 / JIT 核对）

**Files:**
- Create: `docs/ops/permission-onboarding.md`

**Interfaces:**
- Consumes: 设计文档 `docs/superpowers/specs/2026-08-17-permission-onboarding-design.md` §四（章节大纲）、§五（事实锚点）
- Produces: `docs/ops/permission-onboarding.md` 首部 1~250 行（标题 + 互链 + §0 + §1 + §2）；后续任务在其后追加

- [ ] **Step 1: 建文件并写首部（标题 / 定位 blockquote / 互链三份文档）**

首部格式仿 `permission-maintenance.md`：

```markdown
# 权限开通操作手册（新员工入职 / 离职转岗收权）

> 成文 2026-08-17。给运维/管理员本人：给一个人从头配置权限的逐步操作手册。
> 模型总览 / 职责边界 / Casdoor 机制分别见
> [permission-maintenance.md](./permission-maintenance.md) ·
> [permission-boundary.md](./permission-boundary.md) ·
> [casdoor-role-permission-mechanism.md](./casdoor-role-permission-mechanism.md)。
> 设计文档：docs/superpowers/specs/2026-08-17-permission-onboarding-design.md。
```

正文还需写明「大多数新人到第 2 步就完事（默认 manager）」的关键提示。

- [ ] **Step 2: 写 §0 一句话流程 + 开局速查**

一句话流程（照抄设计）：`企微加人 → 通讯录同步 → 薄同步 JIT 建户挂组 → 角色(自动/手动) → 例外(可选) → 验证`。
加一块「开局速查」表格：剩下每个 step 一句话 + 去哪（Casdoor/本系统/企微）+ 什么人需要走。

- [ ] **Step 3: 写 §1 确认人已入企微并同步**

内容要点（命令照抄 Global Constraints + 设计）：
- 企微后台加人（源操作，不在平台内）
- 手动触发：`curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts`；注明每日 03:17 有自动全量兜底，平时加人等下一次薄同步/触发即可
- 核对 SQL（照抄）：
  ```sql
  SELECT wecom_id,name,department_ids,is_active FROM org_users WHERE wecom_id='<工号>';
  -- name=中文名、department_ids 非空 → 同步成功
  ```
- `【截图位】同步结果 / org_users 查询结果`

- [ ] **Step 4: 写 §2 核对 Casdoor 自动建户 + 挂组（JIT 结果）**

内容要点：
- 薄同步每 30 分钟自动扫：provisionUser 建户（`name`=工号、`displayName`=企微中文名）+ syncUserGroups 挂部门组；无手动触发，等下一轮
- 核对两途径：Casdoor 用户列表按 name 搜索；`GET https://sso.shanhaiyiguo.com/api/get-user?id=shanhai/<工号>`
- 异常例：非法用户名（如 `YiBeiMeiShi.` 带点号）— Casdoor 拒建 → thin-sync 失败入 outbox → 需企微侧修正 userid；排查 `docker logs deploy-web-1 --since 48h 2>&1 | grep -iE "provision|outbox"`
- `【截图位】Casdoor 用户列表搜索产物`

- [ ] **Step 5: 核对校验 + 明确小段已写齐 + Commit**

核对：本任务产出的 §1/§2 命令与事实是否逐字等于 Global Constraints；SQL 表名列名与代码一致（`org_users.wecom_id/name/department_ids/is_active`）；文档中三处互链相对路径正确（`./permission-maintenance.md` 等）。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限开通手册—速览/同步/JIT核对三步"
```

---

### Task 2: 第 3~4 步（角色确认修改 / 数据范围）

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§0~§2 之后追加）

**Interfaces:**
- Consumes: 上一任务产出文档推送；Global Constraints 角色表
- Produces: §3、§4 小节

- [ ] **Step 1: 写 §3 角色：确认 / 修改**

要点：
- 自动推导：角色表（照抄 Global Constraints 表格）+「多数人跳过此步」提示
- 修改路径：`Casdoor 组织管理入口（https://sso.shanhaiyiguo.com/login/shanhai）→ Roles → 目标角色 → Sub users → 加人`
- ⚠️ 标注：Sub users 下拉只显示 `工号`（Casdoor 前端写死不显示中文名）；认人对照本系统 `/admin/permissions` 用户列表（中文名 + 工号）
- 覆盖规则：本地 `role_codes` 镜像含推导码之外的附加角色 → 薄同步跳过写入（防橡皮擦），交 drift 翻转 manual 保护——手动改过的角色轮询不会被打回
- `【截图位】Casdoor 角色页 Sub users 编辑态`

- [ ] **Step 2: 写 §4 数据范围：门店 / 品牌品类 / 成本**

要点：
- 门店 = 组挂载：用户所在 Casdoor Group（部门组，企微部门树自动同步）→ groups claim → `data_scope.branch_nums` → RLS 行过滤；一般随组织架构自动成立，确认挂对组即可；异常补挂：Casdoor → 组织架构 → 目标组 → 编辑成员
- 品牌/品类/成本 = 角色内置（full 档 3 角色含 `field:cost`，basic 档 2 角色不含）；一般不用手动勾
- ⚠️ 换行标注：只在收窄/特殊放开时动 Casdoor permission 的 Resources——**必须整字段 update 或删建**，防 AllCols 清空（引 casdoor-role-permission-mechanism.md §3.3 教训）
- `【截图位】Casdoor permission Resources 列表 / 组编辑成员`

- [ ] **Step 3: 校验一致 + Commit**

核对：角色表与 Global Constraints 逐字一致；「full 档 3 角色（boss/zone_manager/finance）、basic 档 2 角色（manager/buyer）」与设计文档 §四/§3-4 一致。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限开通手册—角色确认与数据范围"
```

---

### Task 3: 第 5~7 步 + 收权小节（例外 / 验证 / 离职转岗收权）

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§4 之后追加）

**Interfaces:**
- Consumes: Global Constraints 例外 API/验证命令
- Produces: §5、§6、§7 小节

- [ ] **Step 1: 写 §5 临时例外（本系统唯一权限写入口）**

要点：
- 页面：`/admin/permissions` →「例外」tab（管理员）；维度 门店（branch_number 复合键，如 `3120-0027`）/ 品牌（system_book_code）/ 品类 / 字段 cost；限制 单维 ≤50 条、到期 ≤90 天
- 生效：RLS 每请求实查、即时生效/即时收口（撤销 ≤5min）
- API：`POST/DELETE /api/admin/permissions/grants`；审计 `GET .../audit`
- `【截图位】例外 tab 授权表单`

- [ ] **Step 2: 写 §6 验证三步**

说明第一步 DB 视角（合成）、第二步 claims 视角（管理员预览）、第三步真实会话视角。命令照抄：
```sql
SELECT * FROM get_user_perms('<工号>');
```
`GET /api/admin/permissions/preview?wecom_id=<工号>`（看 groups / data_scope / fields.cost 各段）
登录实际看板（门店行 / 成本列掩码 / 看板卡片）。`【截图位】preview 响应 / 看板实际可见`

- [ ] **Step 3: 写 §7 离职 / 转岗收权**

要点：
- 离职：企微停用/删除 → 通讯录同步写 `is_active=false` → 薄同步 actionDisable（≤30min）：Casdoor disable + `casdoor_writer='disabled'` + `token_blacklist` 拉黑（7 天窗口旧 JWT 即刻拒）→ outbox 重试
- 转岗：改部门 → 同步更新 department_ids → 薄同步按新部门重推导角色并写 Casdoor；无附加角色时旧角色自动摘除
- 例外回收：`/admin/permissions`「例外」撤销（到期自动失效）
- 核对 SQL：`SELECT wecom_id,casdoor_writer,is_active FROM org_users WHERE wecom_id='<工号>';`
- `【截图位】例外撤销 / 离职用户状态`

- [ ] **Step 4: 校验一致 + Commit**

核对：§7 与 `thin-sync/manifest.ts` actionDisable 事实一致（token_blacklist 字段 `user_id/expires_at/reason='offboard'`、7 天 JWT 窗口文案）——只写文案不抄实现细节。

```bash
git add docs/ops/permission-onboarding.md
git commit -m "docs(perm): 权限开通手册—例外/验证/离职转岗收权"
```

---

### Task 4: 附录 A/B/C + 三份文档反向互链

**Files:**
- Modify: `docs/ops/permission-onboarding.md`（§7 之后追加附录）
- Modify: `docs/ops/permission-maintenance.md`（首部 blockquote 加一行指向 onboarding）
- Modify: `docs/ops/permission-boundary.md`（首部 blockquote 加一行指向 onboarding）
- Modify: `docs/ops/casdoor-role-permission-mechanism.md`（首部 blockquote 加一行指向 onboarding）

**Interfaces:**
- Consumes: 全部上文小节内联的【截图位】标注
- Produces: 附录 A/B/C；三份旧文档的「另见」行

- [ ] **Step 1: 附录 A：5 角色速查表**

表格列：角色码 | 档位（cost 有/无）| 典型人群 | 手册对应步骤。数据照抄设计 §附录 A 与 Global Constraints 表（boss/zone_manager/finance=full 含成本；manager/buyer=basic 不含成本；推导规则见 §3）。

- [ ] **Step 2: 附录 B：截图落位表**

汇总全文所有 `【截图位】` 成一张表：列 = 步骤 | 截哪个界面 | 圈哪里 | 建议文件名（如 `01-sync-result.png`）。文案注明「截图由管理员日后按此表补齐，正文【截图位】即对应此行」。

- [ ] **Step 3: 附录 C：排障跳转**

四类问题 → 命令/文档跳转：
- 身份：Casdoor 无户 / 拒建 → §2 异常例 + `docker logs ... | grep provision|outbox`
- 角色：推导 vs 手动不一致 → §3 覆盖规则 + `SELECT ... role_codes,casdoor_writer ...`
- 范围：门店/成本不对 → §4 + `SELECT * FROM get_user_perms(...)` 分支判断
- 例外：preview 与 get_user_perms 不一致 → §5/§6 + 撤销 ≤5min

- [ ] **Step 4: 三份文档反向互链**

在 `permission-maintenance.md`、`permission-boundary.md`、`casdoor-role-permission-mechanism.md` 各自的文首 blockquote（或首行注释区）追加一行：`> 逐步操作（新人开通/收权）：[permission-onboarding.md](./permission-onboarding.md)。`
保持各自原有内容不动。

- [ ] **Step 5: 终审 + Commit**

终审清单：① 全文无 TBD/待补的事实空洞；② `【截图位】` 数量与附录 B 行数相等；③ 互链相对路径全部可解析（`docs/ops/` 内同级）；④ 无与设计文档口径冲突的表述；⑤ 未改动任何非 markdown 文件。

```bash
git add docs/ops/
git commit -m "docs(perm): 权限开通手册—附录速查/落位/排障+三文档互链"
```

---

## Self-Review 记录（计划作者自查）

- **Spec coverage（设计 §四→本计划）**：§0→T1-S2 ✓；§1→T1-S3 ✓；§2→T1-S4 ✓；§3→T2-S1 ✓；§4→T2-S2 ✓；§5→T3-S1 ✓；§6→T3-S2 ✓；§7→T3-S3 ✓；附录 A/B/C→T4-S1/2/3 ✓；反向互链→T4-S4 ✓；设计 §六边界（不改代码）→Global Constraints ✓；§七后续→T4-S5 终审 ✓。
- **Placeholder scan**：各任务步骤均给出可执行动作与内容要点/照抄数据；无 TODO 待办句。文档行号锚点（如「首部 1~250 行」）仅为进度提示，非硬约束。
- **Type/一致性**：角色表在 Global Constraints / T2 / T4 三处引用同一份数据；命令串全文一致（`POST /functions/wecom-sync-contacts`、`get_user_perms`、`/api/admin/permissions/grants`）。