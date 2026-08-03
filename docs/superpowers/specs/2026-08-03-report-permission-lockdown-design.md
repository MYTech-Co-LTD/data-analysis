# 报表权限收口设计(角色+部门双轨)

日期:2026-08-03
状态:已获用户确认(方案 A + 管理页范围 + 人工维护门店清单 + 072 角色种子)

## 背景与断链现状

权限底座在迁移 072/114 后已齐备,但三条链路断裂,导致门店/成本权限事实未收口:

1. **role_id 从不赋值**:`roles`/`dept_role_mapping`/`data_permissions`/`get_user_perms` 都在,但全库无一处写 `org_users.role_id` → 角色层(含角色级 can_see_cost、role_code)空转,实际只剩部门层生效。
2. **报表中心主链路无门店行级收口**:报表中心直查的 `report_*_gen` 生成器视图 owner=postgres、无 `security_invoker`,绕过基表 RLS,且视图 SQL 无任何 branch 过滤——即使收窄 JWT `branch_nums` claim 也裁不了行。只有问数链路(agent-query)和旧视图真正过滤。
3. **成本字段"全员隐藏"**:114 修复 claim 传播后脱敏生效,但 role_id 空 + 部门列 DEFAULT FALSE → 全员 `can_see_cost=false`;生产上以手工放开 `org_departments.can_see_cost` 临时救场,需按新模型还原。

## 权限模型

既有合成逻辑不动:`get_user_perms` = 个人 override > 角色 ∪ 部门(072 已实现)。本轮把断掉的链路接上:

```
wecom-sync-contacts ──按 dept_role_mapping──▶ org_users.role_id(接上断链)
org_departments.branch_nums / can_see_cost ──(人工 SQL 维护)
        │
登录 wecom-oauth ──▶ get_user_perms ──▶ JWT claims(branch_nums/brands/categories/can_see_cost/role_code)
        │
pgrst_pre_request 扁平化 GUC(114 已有)
        │
report_*_gen 视图:WHERE 行过滤(本轮新增)+ CASE 列脱敏(已有)
```

角色种子按 072 执行:boss / zone_manager / finance 可见成本毛利;manager(店长)/ buyer 不可见;部门层 can_see_cost 可额外加开(双轨并集)。

## 组件设计

### C1. 生成器行过滤(方案 A,架构变更)

- `services/semantic-generator/src/generators/tier1.ts` 与 `hierarchy.ts` 模板在视图 SQL 统一注入过滤,照 072 已有的四维模式:
  ```sql
  claim_match_or_star('brands', system_book_code)
  AND claim_match_or_star('branch_nums', branch_num)
  ```
- `categories` 维度只在含品类列的视图(item 级)应用。
- **门店键铁律**:branch_num 跨账套重复,不单独过滤,与 brands(system_book_code) 组合作门店键。
- `claim_match_or_star` 语义不变:claim 缺失或含 `"*"` → 放行(零爆炸半径)。
- **架构文档先行**(CLAUDE.md 铁律):先更新 `docs/architecture.md` 生成器约束节——「权限过滤(行)与脱敏(列)由模板统一注入,新增视图自动继承;禁止在 view-configs / registry 里手写权限逻辑」,再改生成器。
- **契约测试**:生成器 `__tests__` 加断言——所有产物 SQL 必含 brands+branch_nums 过滤;`cost_sensitive=true` 指标必含脱敏 CASE。漏一个视图测试即红。

### C2. role_id 赋值链路

- `functions/wecom-sync-contacts/index.js` upsert 时按 `dept_role_mapping`(部门名正则)赋 `org_users.role_id`。
- `org_users` 加列 `role_source`(`'auto'`/`'manual'`,DEFAULT 'auto'):同步只覆盖 auto;管理页手工指派置 manual,不被同步冲掉。
- 实施第一步先核对生产 `dept_role_mapping` 正则与实际企微部门名的命中率,命中率低先修映射数据再开自动赋值。
- 生产存量回填:重跑一次通讯录同步即完成。

### C3. 权限管理页(/admin/permissions)

只做两块(用户选定):

1. **用户角色指派**:用户搜索列表 → 改 role_id(boss/zone_manager/manager/buyer/finance 下拉)→ 写 `org_users.role_id` + `role_source='manual'`。
2. **生效权限预览**:选用户调 `get_user_perms`,展示合成结果(branch_nums/brands/categories/can_see_cost/role_code)+ 每层来源(角色/部门/个人 override),排障用。

- API:`web/app/api/admin/permissions/*`。**不照抄既有 admin 路由的零鉴权**:路由内校验 JWT `sub ∈ ADMIN_USERIDS`(middleware matcher 不盖 `/api/**`,必须路由内自查)。
- 部门 `branch_nums` / `can_see_cost` 走 SQL 运维脚本 + 运维文档,不进页面。
- 视觉遵守 DESIGN.md(Industrial/Utilitarian,DM Sans + tabular-nums)。

### C4. 生产数据迁移

1. 角色种子按 072 执行(已在库,校准确认)。
2. role_id 批量回填(重跑通讯录同步)。
3. **还原临时放开**:`org_departments.can_see_cost` 按双轨模型重配——确需看成本的部门保留 true,其余还原 false。执行前列出当前手工放开的部门清单给用户确认。
4. 部门 `branch_nums` 初始全部保持 `["*"]`(放行),之后逐部门 SQL 收窄——天然灰度。

## 灰度顺序与回归验证

灰度(每步可独立回滚):

1. 生成器过滤上线,但所有 claims 仍是 `["*"]` → **行为零变化**,先验证不炸。
2. role_id 赋值 + 管理页上线。
3. 逐部门收窄 branch_nums(逐部门验证报表可见性)。
4. 最后还原 can_see_cost 临时放开。

回归手段:

- 生成器契约测试(必含过滤/脱敏断言)。
- 自签 JWT 直连 PostgREST(容器 IP,绕过网关)验证裁行与脱敏,覆盖:无 claim / `"*"` / 收窄后三种 token。
- 各报表页抽查(达成看板、品牌指标、品类汇总、批发日表、供应链出库、商品下钻)。
- 迁移按幂等模板;加列/新建视图或 RPC 后 `docker compose restart postgrest` 刷 schema 缓存。

## 错误处理

- `get_user_perms` 失败兜底保持现状:branch_nums/brands/categories=`["*"]`、can_see_cost=false、role_code=null(保登录可用性);后续另加失败告警,不在本轮。
- 管理页 API 鉴权失败返 401/403,不泄露权限数据。
- 生成器产物不带过滤时契约测试失败,阻断合并。

## 明确不做(本轮)

- 既有 `/api/admin/*` 20 个零鉴权路由的收口(另开一轮;新路由带好头)。
- perms 失败兜底从「放行」改「拒绝」(影响登录可用性,保持现状)。
- 个人 override 管理界面(SQL 可直达 `data_permissions`,不进页面)。
- 部门 branch_nums 的页面化配置(SQL 运维 + 文档)。

## 涉及改动面

| 层 | 文件 |
|---|---|
| 架构文档 | `docs/architecture.md`(生成器约束节) |
| 生成器 | `services/semantic-generator/src/generators/tier1.ts`、`hierarchy.ts` + `__tests__` 契约测试 |
| 生成产物 | `database/generated/*.sql`(重新生成) |
| 迁移 | 新增迁移:`org_users.role_source` 列 + 校准脚本 |
| function | `functions/wecom-sync-contacts/index.js`(role_id 赋值) |
| 前端 | `web/app/admin/permissions/*`、`web/app/api/admin/permissions/*`、`web/lib/auth.ts`(复用 ADMIN_USERIDS) |
| 运维 | 部门权限 SQL 维护文档 |
