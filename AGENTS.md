# AGENTS.md —— data-analysis（山海易果数据平台）

> **本文件是本项目 agent 指令的唯一来源**（Claude / pi / Codex 都从这里读）。
> `CLAUDE.md` 只做一件事：`@AGENTS.md`（Claude Code 的 import 语法）—— **不要在 CLAUDE.md 里再写一份内容**，两份规矩必然漂移。
>
> **团队级通用约束**（由 teamai 分发，本项目不重复写；落点：Claude `~/.claude/rules/common/`、Codex `~/.codex/rules/common/`、pi `~/.pi/agent/rules/common/`）：
> 架构先行 · 数据库迁移纪律 · 部署后验 · 提交与 PR 纪律 · 密钥规矩 · 知识沉淀 · 派发与可见性 · 根本法则（唯一通道 / 无案例不立标准）
>
> 本文件只写**项目专属**内容与参数（路径 / 主机 / 命令）。

## 1. 项目速览

山海易果数据平台（`data.shanhaiyiguo.com`）：采集 / BI / 网关栈。

| 层 | 技术 |
|---|---|
| 前端 | Next.js（`web/`） |
| 后端 | InsForge（`functions/` 为 Deno edge functions）+ PostgREST + PostgreSQL（`database/` 迁移） |
| 生成器 | `services/semantic-generator/`（已 AST 化） |
| 部署 | GitHub Actions → 服务器 `docker compose`（`deploy/`） |

## 2. 文档地图（动手前先读）

| 文档 | 何时必读 |
|---|---|
| `docs/architecture.md` | **任何新功能/改动前**（确认架构是否支持）——改架构的顺序与授权见团队规则 `architecture-first`（人同意 → 更新文档 → 再写码） |
| `DESIGN.md` | **任何视觉 / UI 决策前**（字体、色彩、间距、美学、报表特定约定）——未经同意不得偏离 |
| `openwiki/` | 可选的证据索引（source 与测试为准，不是启动必读） |

## 3. 领域铁律（项目专属）

### 3.1 门店键：`branch_num` 跨账套重复

`branch_num` 跨 lemeng 账套（数据源）重复 —— 3120(熊喵) 与 64188(品品甜) 各自从 1 编号，**128 个 branch_num 两账套都有但对应不同物理门店**，非全局唯一。

- **门店键 = `(system_book_code, branch_num)` 复合，或派生 `branch_number`（= `sbc`-`branch_num`，全局唯一）**。
- **禁止用 `branch_num` 单独 join / 去重 / 做 PK / 做 `.eq()`** —— 必须配 `system_book_code` 或用 `branch_number`。
- 品牌 = `system_book_code`（3120=熊喵鲜生、64188=品品甜），由 `dim_branch` 决定，目标录入不出品牌选择器。
- 品牌拆分：实际值按 `report_daily_*.system_book_code` GROUP BY；目标值按复合键门店目标 SUM。
- 品牌归属 / 配送语义详见 `docs/superpowers/specs/2026-07-28-store-brand-dimension-reform-design.md`。
- **考核战区 = `dim_war_zone` 维表**（`is_assessed` 标东/南/西/中四战区）。`is_assessed_war_zone()` 函数体查此表（数据驱动，签名不变）。增减考核战区改 `dim_war_zone` **数据**，**不动代码 / SQL**。语义层 `dimensions.war_zone` 注册来源。

### 3.2 catalog 单真相

**`capabilityCatalog` 只存在于 `web/lib/capability-catalog.ts`（含 scan 产出的 generated 输入）单副本；function（claims 构建器）只消费不内嵌复制 catalog 子集。**

- 新增视图 / 路由 = 改 view-configs / app 路由，catalog 由 scan 自动发现；
- **在 function 内手写能力清单 = 违规**（function-only 部署走 SSH 直调、不触发 catalog scan，内嵌副本必然漂移）。
- **空集 = deny**：claims 的 `data_scope`/`groups` 段存在但为空 = 授权确定为 ∅，禁止收敛 `["*"]`；enforce 走 RLS 策略分支（迁移 179），严禁对空段使用 `claim_match_or_star`。

### 3.3 生成器约束

`services/semantic-generator/` 已 AST 化（derived 口径从 `metric_registry.formula_ast` 读，`astToSql` 递归翻译）。

- **新增指标 = 改 registry AST；新增视图 = 改 view-configs**，**不改生成器**。
- 在生成器里加「指标特殊处理 / 口径解析」= **违规**（详见 `docs/architecture.md` §10.10 生成器约束铁律）。

### 3.4 采集任务数据完整性（本项目采集类任务必守，五点缺一不可）

任何采集任务（新增或改动）必须内置数据完整性方案，否则不予合并 / 部署：

1. **按维度对账校验**：写库后按采集维度（品牌 / 数据源，**不能用全表数**）比对「库内 active 数 ≥ 源 total」。多品牌共享一张表时尤其注意 —— 全表数会被其它品牌掩盖，partial write 测不出。
2. **拉取完整性**：分页失败要计数、不能静默 `continue` 丢页；不能因某页返回不满 `pageSize` 提前 `break` 丢尾部；以「累计拉取数 ≥ total」判定 `fetchComplete`。
3. **写入失败检测**：upsert 批失败计入 `upsertFailures`；`verified = fetchComplete && upsertFailures===0 && activeCount>=total`。任一失败 → `verified=false`（杜绝 schema 缓存 / 网络抖动导致的 silent success）。
4. **陈旧数据处理（软删除）**：源已删除 / 淘汰的数据不能永久留在表里。全量采集时先把该维度全部标 `is_active=false`，再把本次见到的 upsert 标回 `true`（partial run 不做软删除，避免误标）。
5. **失败 → 告警联动**：`verified=false` → `collect_logs` 记 `failed` → 接入 `collect_fail` 监控告警。完整性不通过必须能被发现，不能静默。

> 关联坑（2026-07-10 商品档案 `is_active` 列踩过）：
> - 加表 / 加列后须 `docker compose restart postgrest` 刷 schema 缓存，否则 PostgREST 400 `Could not find the column ... in the schema cache`（GHA 部署不保证重启 postgrest）。
> - `migrate.sh` 每次部署重跑**全部**迁移；**视图必须 `DROP VIEW IF EXISTS + CREATE VIEW`**，不能用 `CREATE OR REPLACE`（后迁移给视图加列后重跑会报 `cannot drop columns from view`）。
> （这两条已升格为团队规则 `db-migration`。）

## 4. 服务器与环境

目标服务器连接方式：

```
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com
```

密钥文件：`~/.ssh/ShanHai-OPS.pem`（源在企微 WeDrive「拖拉低代码平台/合同档案/其他/ShanHai-OPS.pem」，需复制到 `~/.ssh/` 并 `chmod 600` —— WeDrive 挂载权限 0644 不满足 SSH 要求；旧路径 `/Users/Duo/WPS 云文档/...` 已废弃，WPS 客户端不再挂载）

### 常用操作

```bash
# 连接服务器
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com

# 重启 InsForge 服务
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart insforge"

# 清理 Deno 缓存（用于更新 edge function）
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"

# 查看日志
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-insforge-1 --tail 50"

# 数据库操作
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '<SQL>'"
```

## 5. 部署

### 5.1 改动范围 → 部署方式

**改代码前先用 `git diff --name-only` 判断改动范围，选对应部署方式：**

| 改动范围 | 生产部署方式 | 是否走 GHA |
|---------|------------|-----------|
| **只改 `functions/*/index.js`** | SSH 服务器直调 InsForge API PUT（同 `deploy-functions.sh` 的 deploy_one）+ 清 Deno 缓存 | ❌ 不需要 |
| 改前端 `web/`、迁移 `database/`、配置 `deploy/`、`services/` | GHA 完整部署 | ✅ 需要 |
| function + 前端都改 | SSH 先 PUT function，再 push 走 GHA | ✅ 需要 |

> ⚠️ **本表是本项目的历史双路（InsForge 直调 + GHA），不是公司标准。** 公司标准通道是 **openship**（部署 / 回滚经 openship MCP，见根本法则「唯一通道」）；本表只在维护本平台既有双路时参考。
>
> ⚠️ **InsForge MCP 管的是本地 dev 实例，不是生产。**
> MCP 配置 `--api_base_url http://localhost:7130` 指向**开发者本机**的 InsForge（`deploy-insforge-1` 等 dev 容器）。用它 `update-function` 只会改本地 dev，**生产纹丝不动**。
> - MCP 用途：本地开发迭代 function、查本地 dev 数据。
> - 生产 function 更新：走下面的 SSH 直调 API，或 push 触发 GHA。

### 5.2 只改 function 的生产部署流程

1. SSH 到服务器，直调 InsForge API PUT 更新（与 `deploy-functions.sh` 的 deploy_one 同款；MCP 连本地 dev 改不到生产）

   ```bash
   ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   body=$(jq -n --arg slug "<function-name>" --arg name "<function-name>" --arg desc "<function-name>" --rawfile code "$PWD/../functions/<function-name>/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
   curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/<function-name>'
   ```

2. 清理 Deno 缓存使更新生效（**关键，否则跑旧代码**）

   ```bash
   ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
   ```

3. 验证 function 生效

   ```bash
   curl -s -X POST https://data.shanhaiyiguo.com/functions/<function-name>
   ```

### 5.3 改前端 / 迁移 / 配置的部署流程

> ⚠️ **main 已开分支保护（2026-08-13）**：禁止直推 main，所有改动须 PR + 1 评审通过后合并；force push / 删分支禁用，管理员同样受保护。
> 部署 action 只在 **push main**（PR 合并）时触发，PR 本身不跑 CI —— quality 门禁仍在合并后的 push 阶段把关。

1. 推功能分支 → 开 PR → 评审通过后合并（合并 = 触发 main push 部署）

   ```bash
   git checkout -b feat/xxx && git add . && git commit -m "feat: xxx" && git push origin feat/xxx
   gh pr create --fill
   gh pr merge --squash   # 或 UI 上合并
   ```

2. 检查 GitHub Action 部署状态

   ```bash
   gh run list --limit 3
   gh run watch <run-id>  # 实时监控指定 run
   ```

3. 验证部署成功
   - 前端：`https://data.shanhaiyiguo.com`
   - API：`curl -s https://data.shanhaiyiguo.com/api/health`
   - function：`curl -s -X POST https://data.shanhaiyiguo.com/functions/<function-name>`

### 5.4 GitHub Action CI/CD

项目已配置自动部署（推送到 `main` 触发）：
- Step 1-3：rsync 代码 + 起后端 + 数据库迁移
- Step 4：部署 edge functions（**容错：失败不阻断前端构建**，可用 MCP 单独补）
- Step 5：构建前端镜像 + 推天翼云 + 起网关
- 部署时间约 3-4 分钟

**部署后必验**：
- **容器创建时间 vs 镜像构建时间**（「部署成功」最常见的假绿是**容器跑着旧代码**）——见团队规则 `deploy-verify`
- 或更硬地直接验「新行为」线上可观测
- 新增配置项要检查**所有消费方**：后端运行时 env / 前端**构建期**注入（`NEXT_PUBLIC_*` 运行时注入无效）/ 容器注入

## 6. 测试流程

### 在生产环境测试

1. **企微客户端测试**（推荐）
   - 在企微移动端 / PC 端内打开链接测试
   - 测试登录、页面布局、功能等

2. **API 测试**

   ```bash
   # 测试通讯录同步
   curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts

   # 测试健康检查
   curl -s https://data.shanhaiyiguo.com/api/health
   ```

3. **数据库验证**

   ```bash
   ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT * FROM org_users;'"
   ```

## 7. 常见问题

### CI 质量门禁失败

```bash
gh run view                       # 查看失败原因
bash scripts/check-functions.sh   # 本地运行同样的检查
cd web && npm run lint && npx tsc --noEmit
```

### Deno 缓存导致 function 不更新

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

### function secret 解密失败（注入空串把 function 搞崩）

deno 日志出现 `Failed to decrypt secret <NAME>` = 该 secret 是用历史 `ENCRYPTION_KEY` 加密的孤儿密文。解密失败时运行时会注入**空串**并**覆盖容器 env**，导致读到该 secret 的 function 拿到空值崩溃。

- 排查：`docker logs deploy-deno-1 --since 48h 2>&1 | grep -i decrypt`
- 根因：`ENCRYPTION_KEY` 曾被改动 / 曾靠留空回退 `JWT_SECRET`（现已改必填）。
- 治愈：`deploy-functions.sh` 的 `set_secret` 已是 **upsert**（POST 409→PUT），重跑即用当前 key 把全部 secret 重加密一遍：

  ```bash
  ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform && bash scripts/deploy-functions.sh"
  ```

- 死 secret（无 function 读取的历史残留，如 `INSFORGE_API_KEY`）解密也会报错，确认无引用后 `DELETE /api/secrets/<KEY>` 清掉。

### 数据库权限问题

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'GRANT INSERT, SELECT, UPDATE ON org_users, org_departments TO anon, authenticated;'"
```

### 重新登录获取姓名

- 清除浏览器 cookie 或访问 `/login` 触发重新授权

## 8. 质量控制（本仓）

### 1. 设置 Git Hooks（首次必须执行）

```bash
bash scripts/setup-hooks.sh
```

这会启用 pre-commit hook，在每次 `git commit` 前自动运行：
- **lint-staged**：对修改的 ts/tsx 文件运行 ESLint
- **check-functions.sh**：检查所有 Edge Function 的语法和结构

### 2. 推送前必须自检

```bash
# 方式一：直接运行完整检查（推荐）
bash scripts/check-functions.sh && cd web && npm run lint && npx tsc --noEmit

# 方式二：让 CI 来检查（推送后 GitHub Actions 会自动运行）
# 但如果 CI 失败，部署会被阻断，需要重新修复推送
```

### 3. CI 质量门禁

每次推送到 `main` 分支，GitHub Actions 会自动运行：**Lint**（ESLint）/ **Type Check**（tsc）/ **Function Check**（Edge Function 语法）。
**只有所有检查通过才会部署到生产环境。**

### 4. Edge Function 开发规范

- 每个 function 必须有 `index.js` 或 `index.ts`
- JavaScript 文件必须有 `module.exports = async function(request) { ... }`
- TypeScript 文件必须有导出或 `serve()`（Deno）

### 5. 数据库迁移规范

- 所有迁移脚本**必须幂等**（`IF NOT EXISTS` / `DROP ... IF EXISTS` / `ON CONFLICT`；视图用 `DROP VIEW + CREATE VIEW`）
- 迁移末尾加验证断言，避免重复创建
- **迁移模板**：`database/MIGRATION_TEMPLATE.md`
- 提交前本地先跑 `bash scripts/migrate.sh` 验证

> 完整规则见团队规则 `db-migration`（幂等 + 外部字段用 `TEXT` + PostgREST 缓存）。

## 9. 新增功能开发检查清单

**代码开发**
- [ ] 迁移文件用幂等模板（`database/MIGRATION_TEMPLATE.md`）
- [ ] **外部系统数据字段用 `TEXT`**，不要用 `VARCHAR`
- [ ] 环境变量：后端 + 前端（构建期）+ 容器注入

**本地验证**
- [ ] TypeScript 编译通过
- [ ] 迁移 SQL 语法正确
- [ ] 新增 API 路由存在
- [ ] 快速本地验证（不走 GHA）：`ssh server "docker exec deploy-web-1 node -e '<测试代码>'"`

**部署验证**
- [ ] GHA 成功（5 steps 全绿）
- [ ] **容器镜像 / 容器创建时间已更新**（防「容器跑旧代码」）
- [ ] 新功能可访问

**数据验证**
- [ ] 数据写入正确
- [ ] 权限正确（anon / authenticated）
- [ ] RLS 策略（如需要）

## 10. 历史：开发流程问题总结（2026-07-04）

> 该轮 4 次失败的根因是「验证周期长 + 幂等设计缺失 + 环境配置碎片化」。现已收敛为通用规则：
> 迁移幂等 / 字段类型 → `db-migration`；部署后验证 → `deploy-verify`；架构与文档顺序 → `architecture-first`。
> 下面只留**仍未收敛到规则、但值得记**的部分。

### 4 次失败（案例：商品档案采集）

1. **迁移不幂等**：触发器重复创建 → `ERROR: trigger already exists`；`INSERT` 无 `ON CONFLICT` → `duplicate key value`。
2. **VARCHAR 长度不够**：商品名称/编号超长 → `value too long for type character varying(100)`。
3. **GHA 部署失败**：`INSFORGE_API_KEY` 无效 → function 部署 401 → Step 4 失败连带跳过 Step 5（前端未部署）。
4. **环境变量读取错误**：`NEXT_PUBLIC_INSFORGE_ANON_KEY` 在容器中不存在，代码 fallback 到 `''` → PostgREST 401。

### 仍成立的关键教训（已升格为团队规则的不再重复）

| 问题 | 教训 | 现状 |
|-----|------|------|
| 迁移文件不幂等 | 所有 DDL 先 `DROP IF EXISTS` / `IF NOT EXISTS` | → 团队规则 `db-migration` |
| VARCHAR 反复改 | 外部系统数据一律 `TEXT` | → 团队规则 `db-migration` |
| 环境变量漏配 | 新增功能检查所有消费方（后端/前端构建期/容器注入） | → 团队规则 `deploy-verify` |
| 容器跑旧代码 | 部署后验容器创建时间 vs 镜像构建时间 | → 团队规则 `deploy-verify` |
| nginx 配置语法错误 | `location` 必须在 `server` block 内，不能独立成文件 | 本项目约定 |
| PostgREST schema 缓存 | 改表结构后必须重启 PostgREST | → 团队规则 `db-migration`（条件条款） |
| **GHA 单步失败阻断整个部署** | function 步骤已加容错（失败不阻断前端构建），但仍要在告警里可见 | 本项目已落地（§5.4） |
| **验证周期长（30min–2h/次）** | 本机缺完整栈（InsForge + PostgREST + PG）⇒ 大量依赖"push 后才知道" | **未收敛**：长期方向是本地镜像生产的完整栈 |

### 仍未收敛的改进项（本仓 backlog）

- InsForge API Key 有效性自愈（现靠人工发现 401）
- 本地 `docker-compose.dev.yml` 模拟完整栈，减少“只能 push 后验证”
- 从 PostgreSQL 生成 TypeScript 类型，避免字段长度/类型反复改；VARCHAR 统一长度参考（编号/编码 200、名称 500、类别 200、状态 50）——但**新字段优先 `TEXT`**
- GHA 脚本加固：关键步骤加 retry（3 次 / 5s）、失败时输出详细错误（不吞 `curl` 输出）

## 11. OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.
