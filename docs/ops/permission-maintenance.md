# 权限运维手册（2026-08-17 平台级权限标准化后）

> 旧版（2026-08-13 data_permissions 四维模型口径）已随 185 sunset 作废。
> 当前模型：**Casdoor = 管理面真相源，data-analysis = 执行面（合成/缓存/强制）**。
> 架构真相源总表见 `docs/architecture.md` §6.0。

## 模型（谁管什么）

| 改什么 | 去哪改 | 生效时机 |
|---|---|---|
| 组织架构 / 部门组挂载（=门店可见范围） | Casdoor（企微通讯录同步组树，`sso.shanhaiyiguo.com`） | 用户下次登录 |
| 角色 / 看板-品牌-品类-成本能力勾选 | Casdoor → Permission（data-analysis-full / basic）resources | 用户下次登录 |
| **带到期临时例外**（≤90 天） | 本系统 `/admin/permissions`「例外」 | RLS 每请求实查，**即时生效/即时收口** |
| 权限怎么被执行（RLS/视图/过滤逻辑） | data-analysis 代码（architecture.md §6.2） | 发版 |

- 生效权限合成：登录时 callback 产 claims（`permissions` 资源串 + `groups` + `data_scope{brands,categories,branch_nums}` + `fields.cost`）；行过滤 `scope_match_v2`、列脱敏 `can_cost_visible`、能力面 `checkFeaturePerm`。
- 门店键铁律不变：`branch_num` 跨账套重复，执行面永远用 `branch_number` 复合键（'3120-0027'，尾段前导零归一两侧对称）。

## 例外通道（本系统唯一权限写入口）

- 页面 `/admin/permissions`（管理员）：授予 / 撤销 / 审计，单维 ≤50 条、到期 ≤90 天。
- API：`POST/DELETE /api/admin/permissions/grants`；`GET .../audit` 留痕。
- 消费面：`get_user_perms` RPC 实查（agent-query / PG 会话路径）+ `web/lib/exception-grants.ts`（middleware 快判，5min TTL，撤销主动失效）。

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
