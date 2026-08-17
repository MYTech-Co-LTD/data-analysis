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