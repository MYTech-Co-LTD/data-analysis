# Casdoor 功能点显示加「组|」前缀 · 设计

**日期**: 2026-08-17
**状态**: 待实现
**上游**: `2026-08-15-platform-casbin-novu-unified-design`（功能授权三层）、`2026-08-16-platform-iam-standardization-design`（能力点 catalog 单真相）、`2026-08-17-unify-view-board-friendly-name`（通俗名归一）

## 背景与问题

Casdoor 管理端（sso.shanhaiyiguo.com）权限配置页的资源下拉框显示 `resource.name`。当前生产 34 个 resource 是**混合形态**：

- 21 个映射名：`data-analysis_view_reports`、`data-analysis_admin` 等（`:` 转 `_`）
- 13 个通俗名：`指标概览`、`门店零售` 等（看板/KPI 能力）

管理员在 Casdoor 下拉框中看到的功能点**不带组信息**，无法区分「经营总览」属于看板还是别的模块。**需求**：Casdoor 下拉框所有功能点统一显示 `组|功能点` 格式，如 `看板|经营总览`、`品牌|熊喵鲜生`、`门禁|管理台`。

## 关键事实（生产实测 2026-08-17）

1. **`resource.name` 即 Casdoor 下拉框显示值**（源码确认：PermissionEditPage `getOption(resource.name)`）。
2. **半角 `|` 可写入**：`add-resource` 实测接受 `看板|测试半角`（status ok）。全角 `｜` 亦接受。
3. **`update-resource` 改名不可用**：生产 fork 的 `getResource` 查询强制加 `/` 前缀，而存储是裸名 → 对任何存量资源定位不到（实测 `Unaffected` / `data:null`）。
4. **`delete-resource` 不可用**：生产未配置 Storage provider（实测 `No provider for category: Storage`）。
5. **存量资源改名/清理只能走数据库直改**：生产 Casdoor 数据库在 `opsh`（113.249.101.33）的 `casdoor-postgres` 容器，SSH 已打通（`~/.ssh/openship-ops`，config 别名 `opsh`）。
6. **`resource.name` 是授权载体**：管理员勾选后写进 `permission.resources` → `get-all-objects` 返回 → claims.js/feature-perm/reconcile 用 `FRIENDLY_TO_KEY`/`LABEL_TO_KEY` 反查回 key。**改 name 必须同步改全部消费侧反查表**，否则授权断裂。

## 目标形态

```
看板|经营总览        (data-analysis:view:reports)
看板|目标达成        (data-analysis:view:reports-targets)
看板|报表看板全组     (data-analysis:view-group:reports-all)
看板|指标概览        (data-analysis:view-board:kpi)
...
字段|成本可见        (data-analysis:field:cost)
品牌|熊喵鲜生        (data-analysis:brand:3120)
品牌|品品甜          (data-analysis:brand:64188)
品类|水果           (data-analysis:category:水果)
品类|标品           (data-analysis:category:标品)
品类|耗材           (data-analysis:category:耗材)
门禁|管理台         (data-analysis:admin)
```

- **有通俗名**（label）：`组|label`，如 `看板|经营总览`、`门禁|管理台`
- **无通俗名**（只有映射名 enc(key)）：`组|映射名`（当前 catalog 全量有 label，此分支为未来 scan 自动发现兜底——scan 新发现视图未配 OVERRIDES label 时 label 是英文 slug，如 `看板|new-slug`）

## 设计

### 1. catalog 层：新增双映射（`web/lib/capability-catalog.ts`）

新增导出（保留现有 `KEY_TO_LABEL`/`LABEL_TO_KEY` 不动，兼容前端能力页纯 label 展示）：

```ts
// 展示名（Casdoor resource.name）：key → `组|label`（无 label 退回 `组|映射名`）
export const KEY_TO_DISPLAY_NAME: ReadonlyMap<string, string>
// 反查：`组|label`/`组|映射名` → key
export const DISPLAY_NAME_TO_KEY: ReadonlyMap<string, string>
```

- 构建基于 `deduped`（含 OVERRIDES 合并后的最终 group/label），与 `KEY_TO_LABEL` 同源，H12 不立第二副本。
- 唯一性断言：`displayName` 必须全局唯一（resource.name 是主键 + 反查不可歧义）——在 catalog 加载时断言，与现有 label 唯一断言同模式。
- 分隔符常量 `DISPLAY_SEP = '|'` 导出。

> 设计取舍：保留 `KEY_TO_LABEL`/`LABEL_TO_KEY` 不动（前端能力页纯 label 展示用），新增双映射供 Casdoor 侧。消费侧 `buildPermPool` 反查虽在 claims.js 归一后通常不再命中（前端收到的是 key），但保留防御性反查并同步新格式，防「未经济一直接进判定池」的路径（测试覆盖）。

### 2. 写入侧（`web/lib/sync/resource-sync.ts`）

`displayName()` 从 `KEY_TO_LABEL.get(key) ?? enc(key)` 改为 `KEY_TO_DISPLAY_NAME.get(key) ?? (组 + DISPLAY_SEP + enc(key))`。

### 3. 消费侧反查（3 处，全量换用新格式）

| 文件 | 现状 | 改后 |
|---|---|---|
| `functions/wecom-oidc-callback/claims.js` | `FRIENDLY_TO_KEY`（23 条通俗名静态镜像） | 键改为 `组|label` 形态（含 watch/KPI/catalog 具名全量） |
| `web/lib/feature-perm.ts` | `buildPermPool` 用 `LABEL_TO_KEY` | 改用 `DISPLAY_NAME_TO_KEY` |
| `web/lib/reconcile-catalog.ts` | `normKey` 用 `LABEL_TO_KEY` | 改用 `DISPLAY_NAME_TO_KEY` |
| `scripts/reconcile-catalog.mjs` | `FRIENDLY_TO_KEY` 静态镜像 | 键改为 `组|label` 形态 |

> claims.js 与 scripts/reconcile-catalog.mjs 的静态镜像为 H12 例外（跨 TS/CJS 边界无法 import，测试断言防漂移）——同步 23 条为 `组|label` 形态。

### 4. 存量迁移（脚本 + 一次性执行）

**脚本 `scripts/migrate-resource-display-prefix.mjs`**（参考 `migrate-perms-friendly.mjs` 模式，`--live` 才写入）：

- **resource 表**：`opsh` 上 `casdoor-postgres` 直连 SQL，`UPDATE resource SET name = '<组|label>' WHERE description = '<key>'`（description 恒存 key 原文，权威可逆）。34 个全量。
- **permission.resources**：`update-permission` API 更新 5 个 role-* 的 resources 数组，旧通俗名 → `组|label`（通配 `view-board:*`/`view-kpi:*` 保持 key 原样，不翻译）。
- 先 `--dry-run` 打印 plan，确认后 `--live` 执行 + 对账验证。

**迁移顺序**（防授权窗口断裂）：

1. 改代码 + 部署（新格式反查表生效）
2. 迁移 resource 表 name（DB 直改）
3. 迁移 permission.resources（API）
4. 对账（`scripts/reconcile-catalog.mjs` / 能力页红区）确认无红
5. 用户重新登录（claims 重建，5min 缓存窗口内新旧 token 并存，但反查表已兼容旧格式？）

> ⚠ 迁移窗口兼容：反查表改为 `组|label` 后，旧 token 里 permission 串是旧通俗名 → 无法反查。**决策：迁移窗口不做双格式兼容**——改代码 + 迁移 DB/API 在同一部署窗口完成，用户重新登录即取新 claims。旧 token 5min 内（claims 缓存）或自然过期后失效，与 2026-08-17 通俗名迁移同款窗口处理（migrate-perms-friendly 先例）。

### 5. 前端能力页（`web/app/admin/capabilities/page.tsx`）

**不改**。能力页有独立「组」列 + 「标签」列，纯 label 展示，与 Casdoor 侧无关。类型 `CatalogEntry` 中 `name?` 字段已随上一次 commit 删除。

### 6. 测试

- `web/lib/__tests__/capability-catalog.test.ts`：新增 `KEY_TO_DISPLAY_NAME`/`DISPLAY_NAME_TO_KEY` 用例（双向一致、唯一性、`组|label` 形态断言）
- `web/lib/sync/__tests__/resource-sync.test.ts`：`displayName` 用新格式
- `web/lib/__tests__/feature-perm.test.ts`：permission 串为 `组|label` 时判定正确
- `web/lib/__tests__/reconcile-catalog.test.ts`：`组|label` 归一不误报
- `functions/wecom-oidc-callback/claims.test.js`：FRIENDLY_TO_KEY 新形态断言
- `scripts/tests/reconcile-catalog.test.mjs`：CLI 镜像同步断言

## 影响面清单（变更文件）

- `web/lib/capability-catalog.ts`（+双映射、分隔符常量、唯一断言）
- `web/lib/sync/resource-sync.ts`（displayName）
- `web/lib/feature-perm.ts`（buildPermPool 反查）
- `web/lib/reconcile-catalog.ts`（normKey）
- `functions/wecom-oidc-callback/claims.js`（FRIENDLY_TO_KEY）
- `scripts/reconcile-catalog.mjs`（FRIENDLY_TO_KEY）
- `scripts/migrate-resource-display-prefix.mjs`（新建，存量迁移）
- 测试：capability-catalog / resource-sync / feature-perm / reconcile-catalog（web+scripts）/ claims.test.js

## 不做（YAGNI）

- 不做双格式兼容（迁移窗口不兼容旧通俗名，一次性窗口处理）
- 不改前端能力页展示（纯 label 已够，有组列）
- 不 resource 化门店（既有决策，与此无关）
- 不处理 DEPRECATED 11 个 key 的存量 resource（废弃不注册，DB 中残留不影响下拉框主列表？——见下）

## 遗留问题：DEPRECATED 残留 resource

生产 resource 表有 11 个废弃 key 的映射名（`data-analysis_view_mobile` 等），它们**不在 catalog**（DEPRECATED 过滤），不会被 sync 注册，但 DB 中残留。本次迁移**不迁移它们**（无对应 label/组），保持原样。它们不出现在能力页（被 DEPRECATED 过滤），但会出现在 Casdoor 下拉框。**决策：本次不动**（避免扩大范围；废弃资源无授权引用，不构成风险）。如需清理另立任务。

## 验证方式

1. `bash scripts/check-functions.sh` + `cd web && npm run lint && npx tsc --noEmit` + `npx vitest run`
2. 生产迁移后：`scripts/reconcile-catalog.mjs` 无红
3. Casdoor 管理端下拉框人工确认显示 `组|label`
4. 用户登录 claims 确认 permission 串为 `组|label` 且功能正常