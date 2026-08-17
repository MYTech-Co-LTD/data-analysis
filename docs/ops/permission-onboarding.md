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