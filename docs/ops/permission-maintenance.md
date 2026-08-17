# 权限运维手册（2026-08-17 平台级权限标准化后）

> 旧版（2026-08-13 data_permissions 四维模型口径）已随 185 sunset 作废。
> 当前模型：**Casdoor = 管理面真相源，data-analysis = 执行面（合成/缓存/强制）**。
> 架构真相源总表见 `docs/architecture.md` §6.0。

## 模型（谁管什么）

| 改什么 | 去哪改 | 生效时机 |
|---|---|---|
| 组织架构 / 部门组挂载（=门店可见范围） | Casdoor（企微通讯录同步组树，`sso.shanhaiyiguo.com`） | 用户下次登录 |
| 角色 / 看板-品牌-品类-成本能力勾选 | Casdoor → Permission（role-boss / zone_manager / finance / manager / buyer）resources | 用户下次登录 |
| **看板模块 / KPI 卡片级能力**（view-board:\*/view-kpi:\*） | Casdoor → Permission resources（默认全开通配，可收权到具名 key） | 用户下次登录 |
| **带到期临时例外**（≤90 天） | 本系统 `/admin/permissions`「例外」 | RLS 每请求实查，**即时生效/即时收口** |
| 权限怎么被执行（RLS/视图/过滤逻辑） | data-analysis 代码（architecture.md §6.2） | 发版 |

- 生效权限合成：登录时 callback 产 claims（`permissions` 资源串 + `groups` + `data_scope{brands,categories,branch_nums}` + `fields.cost`）；行过滤 `scope_match_v2`、列脱敏 `can_cost_visible`、能力面 `checkFeaturePerm`。
- 门店键铁律不变：`branch_num` 跨账套重复，执行面永远用 `branch_number` 复合键（'3120-0027'，尾段前导零归一两侧对称）。

## 例外通道（本系统唯一权限写入口）

- 页面 `/admin/permissions`（管理员）：授予 / 撤销 / 审计，单维 ≤50 条、到期 ≤90 天。
- API：`POST/DELETE /api/admin/permissions/grants`；`GET .../audit` 留痕。
- 消费面：`get_user_perms` RPC 实查（agent-query / PG 会话路径）+ `web/lib/exception-grants.ts`（middleware 快判，5min TTL，撤销主动失效）。

## 看板 / KPI 卡片级能力（2026-08-17）

每个看板抽象成能力（`data-analysis:view-board:<id>`，7 个），每个 KPI 指标卡同理
（`data-analysis:view-kpi:<code>`，6 个含 2 派生比率卡）。单真相在
`web/lib/capability-board.ts`（纯数据：key/通俗命名/描述）；BOARDS 各 manifest 与
capability-catalog 都引用它。

- **默认全开（fail-open，用户拍板「避免上线即收权」）**：用户 permissions 未配置任何
  该命名空间能力（旧 token / 未登录 / 未配置）→ 全部看板/卡片可见；**只有明确配置了
  「部分具名能力」的角色才裁剪到配置集**。判定实现 `hasBoardPerm` / `hasKpiPerm`
  （web/lib/feature-perm.ts）。
- **分层设计**：页面级 `view:*`（页面访问）与看板级 `view-board:*`（看板模块）解耦。
- **数据范围由 RLS 兜底**：显示层过滤为软门禁，真实行裁剪靠 PostgREST RLS 按
  branch_nums 实施（战区负责人只看自己战区，天然成立）。
- **Casdoor 配置**：5 角色 permission 均已追加 `view-board:*` + `view-kpi:*` 通配
  （默认全开）；收权时改成具名 key 列表即可（update-permission 必须带全字段防
  AllCols 清空，见 casdoor-role-permission-mechanism.md 教训）。

## 方案 C：统一视图/看板 + 全量通俗名（2026-08-17）

**核心语义：报表授权 ⇒ 视图访问（能看板 = 能访问该看板的报表视图）。**

- **退役 11 个零消费 `view:*` 死 key**（8 个 `report_*_gen` + `view:mobile` +
  `view:reports-items` + `view:wholesale-customers`）：无任何消费面，统一由
  看板能力覆盖。清单见 `web/lib/capability-catalog.ts` 的 `DEPRECATED`。
- **看板覆盖视图**：`web/lib/capability-board.ts` 的 `BOARD_VIEW_COVERAGE` 声明
  每个看板覆盖的底层报表视图名。消费侧（`buildPermPool` / claims.js）命中看板
  能力时注入对应 `view:*` key → 报表授权闭环。
- **页面级保留 2 个 `view:*`**：`view:reports`（经营总览）/ `view:reports-targets`
  （目标达成）仍作页面级 middleware 门禁（`/reports*` 路由）。
- **permission.resources 存通俗名**：5 角色 permission 的具名资源改写为通俗名
  （如「经营总览」「成本可见」），get-all-objects 返回通俗名 → claims.js/前端
  `FRIENDLY_TO_KEY`/`LABEL_TO_KEY` 反查 key。**通配（`view-board:*` / `view-kpi:*`）
  恒为 key**（无法通俗化）。
- **迁移脚本**：`scripts/migrate-perms-friendly.mjs`（dry-run 默认，`--live` 写入，
  update-permission 全字段防 AllCols 清空）。

## 对账与门禁（自动化，勿手工干预）

- `__reconcile_groups` 每日 03:37 UTC：组→门店投影 vs 期望源（dim 考核门店 × 区域经理覆盖）。红区=未覆盖门店；白名单人工审批在 `group_reconcile_history.detail.whitelist`。
- `__reconcile_catalog` 每日 03:47 UTC：Casdoor permission.resources vs capability catalog。
- 7 天门禁（W2 退出判据）：连续 7 行 `whitelist_outside_diff=0 ∧ red=0`。

## 排障

```sql
-- 生效权限合成（DB 视角；branch_nums=组投影展开，can_see_cost=例外实查）
SELECT * FROM get_user_perms('<wecom_id>');
```

- 登录 claims 排障：`GET /api/admin/permissions/preview?wecom_id=<id>`（管理员）。
- Casdoor 可达对象（登录链路同源）：`GET {sso}/api/get-all-objects?userId=shanhai/<name>`。
- 管理台门禁 = BREAKGLASS_ADMINS env（当前 ZhangDuo/YangWei）+ `data-analysis:admin` 资源（当前不授予任何 Permission，纯 breakglass）。

## 已下线（勿再引用）

- `data_permissions` 表（已 DROP）/ 个人 override / 部门四维 / 角色默认范围 / `/admin/permissions` 用户-部门-角色三 tab / 对应 PUT API。
- 旧四维 JWT 顶层 key（B6 摘除；旧形状令牌 = RLS deny）。
- **退役 11 个 `view:*` 死 key**（方案 C，2026-08-17）：`view:mobile`、8 个
  `report_*_gen`、`view:reports-items`、`view:wholesale-customers`——勿再引用，
  报表授权由对应看板能力覆盖。
