# CLAUDE.md

## 架构变更规则（重要）

**所有代码实现必须严格按照架构文档执行。**

架构文档位置：`docs/architecture.md`

核心规则：
1. **架构先行**：任何新功能、改动必须先查看架构文档，确认架构是否支持
2. **变更流程**：如需修改架构，必须先征得用户同意 → 更新架构文档 → 再执行代码实现
3. **禁止擅自变更**：不得在未更新架构文档的情况下擅自改变服务拆分、数据流向、技术栈、存储方案等

这包括但不限于：
- 服务拆分/合并
- 技术栈更换
- 数据流向调整
- 组件新增/删除
- 存储方案变更
- 接口设计变更
- 鉴权方案变更
- **生成器改动**（`services/semantic-generator/`）：改生成器代码属架构变更。生成器已 AST 化（derived 口径从 `metric_registry.formula_ast` 读，`astToSql` 递归翻译）。**新增指标 = 改 registry AST；新增视图 = 改 view-configs**，不改生成器。在生成器加「指标特殊处理/口径解析」= 违规（详见 architecture.md §10.10 生成器约束铁律）

在讨论架构时，应给出完整的方案对比和推荐理由，等用户确认后再实施。

## 采集任务数据完整性规则（重要）

**任何采集任务（新增或改动）必须内置数据完整性方案，否则不予合并/部署。**

"完整性方案"至少覆盖以下五点（缺一不可）：

1. **按维度对账校验**：写库后按采集维度（品牌/数据源，**不能用全表数**）比对"库内 active 数 ≥ 源 total"。多品牌共享一张表时尤其注意——全表数会被其它品牌掩盖，partial write 测不出。
2. **拉取完整性**：分页失败要计数、不能静默 `continue` 丢页；不能因某页返回不满 `pageSize` 提前 `break` 丢尾部；以"累计拉取数 ≥ total"判定 `fetchComplete`。
3. **写入失败检测**：upsert 批失败计入 `upsertFailures`；`verified = fetchComplete && upsertFailures===0 && activeCount>=total`。任一失败 → `verified=false`（杜绝 schema 缓存/网络抖动导致的 silent success）。
4. **陈旧数据处理（软删除）**：源已删除/淘汰的数据不能永久留在表里。全量采集时先把该维度全部标 `is_active=false`，再把本次见到的 upsert 标回 `true`（partial run 不做软删除，避免误标）。
5. **失败→告警联动**：`verified=false` → collect_logs 记 `failed` → 接入 `collect_fail` 监控告警。完整性不通过必须能被发现，不能静默。

> 关联坑（实测，2026-07-10 商品档案 is_active 列踩过）：
> - 加表/加列后须 `docker compose restart postgrest` 刷 schema 缓存，否则 PostgREST 400 `Could not find the column ... in the schema cache`（GHA 部署不保证重启 postgrest）。
> - `migrate.sh` 每次部署重跑**全部**迁移；视图必须用 `DROP VIEW IF EXISTS + CREATE VIEW`，不能用 `CREATE OR REPLACE`（后迁移给视图加列后重跑会报 `cannot drop columns from view`）。

## 门店键铁律（重要）

`branch_num` 跨 lemeng 账套（数据源）重复——3120(熊喵) 与 64188(品品甜) 各自从 1 编号，**128 个 branch_num 两账套都有但对应不同物理门店**，非全局唯一。

- **门店键 = `(system_book_code, branch_num)` 复合，或派生 `branch_number`（=`sbc`-`branch_num`，全局唯一）**。
- **禁止用 `branch_num` 单独 join / 去重 / 做 PK / 做 `.eq()`。** 必须配 `system_book_code` 或用 `branch_number`。
- 品牌 = `system_book_code`（3120=熊喵鲜生、64188=品品甜），由 `dim_branch` 决定，目标录入不出品牌选择器。
- 品牌拆分：实际值按 `report_daily_*.system_book_code` GROUP BY；目标值按复合键门店目标 SUM。
- 品牌归属/配送语义详见 `docs/superpowers/specs/2026-07-28-store-brand-dimension-reform-design.md`。
- **考核战区 = `dim_war_zone` 维表**（`is_assessed` 标东/南/西/中四战区）。`is_assessed_war_zone()` 函数体查此表（数据驱动，签名不变）。增减考核战区改 `dim_war_zone` 数据，**不动代码/SQL**。语义层 `dimensions.war_zone` 注册来源。

## 服务器 SSH 连接

目标服务器连接方式：

```
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com
```

密钥文件：`~/.ssh/ShanHai-OPS.pem`（源在企微 WeDrive「拖拉低代码平台/合同档案/其他/ShanHai-OPS.pem」，需复制到 `~/.ssh/` 并 `chmod 600`——WeDrive 挂载权限 0644 不满足 SSH 要求；旧路径 `/Users/Duo/WPS 云文档/...` 已废弃，WPS 客户端不再挂载）

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

## 部署流程

### ⚠️ 部署决策规则（重要）

**改代码前先用 `git diff --name-only` 判断改动范围，选择对应部署方式：**

| 改动范围 | 生产部署方式 | 是否走 GHA |
|---------|------------|-----------|
| **只改 `functions/*/index.js`** | SSH 服务器直调 InsForge API PUT（同 `deploy-functions.sh` 的 deploy_one）+ 清 Deno 缓存 | ❌ 不需要 |
| 改前端 `web/`、迁移 `database/`、配置 `deploy/`、`services/` | GHA 完整部署 | ✅ 需要 |
| function + 前端都改 | SSH 先 PUT function，再 push 走 GHA | ✅ 需要 |

**核心原则：只改 function 时，不要 `git push` 触发 GHA。** GHA 部署 function 有限流（429）、构建慢、容易因无关步骤失败。

> ⚠️ **InsForge MCP 管的是本地 dev 实例，不是生产。**
> MCP 配置 `--api_base_url http://localhost:7130` 指向**开发者本机**的 InsForge（`deploy-insforge-1` 等 dev 容器）。用它 `update-function` 只会改本地 dev，**生产纹丝不动**。
> - MCP 用途：本地开发迭代 function、查本地 dev 数据。
> - 生产 function 更新：走下面的 SSH 直调 API，或 push 触发 GHA。

### 只改 function 的生产部署流程

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

### 改前端/迁移/配置的部署流程

1. 推送到 GitHub 触发 CI/CD
   ```bash
   git add . && git commit -m "feat: xxx" && git push origin main
   ```

2. 检查 GitHub Action 部署状态
   ```bash
   gh run list --limit 3
   gh run watch <run-id>  # 实时监控指定 run
   ```

3. 验证部署成功
   - 检查前端：`https://data.shanhaiyiguo.com`
   - 检查 API：`curl -s https://data.shanhaiyiguo.com/api/health`
   - 检查 function：`curl -s -X POST https://data.shanhaiyiguo.com/functions/<function-name>`

### GitHub Action CI/CD

项目已配置自动部署（推送到 `main` 触发）：
- Step 1-3：rsync 代码 + 起后端 + 数据库迁移
- Step 4：部署 edge functions（**容错：失败不阻断前端构建**，可用 MCP 单独补）
- Step 5：构建前端镜像 + 推天翼云 + 起网关
- 部署时间约 3-4 分钟

## 测试流程

### 在生产环境测试

1. **企微客户端测试**（推荐）
   - 在企微移动端/PC 端内打开链接测试
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

## 常见问题

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

## 开发流程问题总结（2026-07-04）

### 核心问题

**每次新增功能都要反复调试，验证周期长，效率低。**

根因是 **验证周期太长** + **幂等设计缺失** + **环境配置碎片化**。

---

### 问题链分析

#### 案例：商品档案采集功能开发

**第一次失败**：迁移文件不幂等
- 触发器重复创建 → `ERROR: trigger already exists`
- INSERT 无 ON CONFLICT → `ERROR: duplicate key value`
- 修复：加 `DROP TRIGGER IF EXISTS` + `ON CONFLICT DO UPDATE`

**第二次失败**：VARCHAR 长度不够
- 商品名称/编号超长 → `ERROR: value too long for type character varying(100)`
- 修复：`ALTER COLUMN ... TYPE VARCHAR(200/500)`

**第三次失败**：GHA 部署失败
- `INSFORGE_API_KEY` 无效 → function 部署 401
- GHA Step 4 失败，跳过 Step 5（前端构建）
- 新增的 `/api/admin/collect-items` 路由未部署

**第四次失败**：环境变量读取错误
- `NEXT_PUBLIC_INSFORGE_ANON_KEY` 在容器中不存在
- 代码 fallback 到 `''`，PostgREST 返回 401

---

### 系统性问题清单

#### 1. API Key 管理不透明
- InsForge 的 API Key 生成/验证机制不明
- Key 过期或无效时无自动更新
- `deploy/.env` 中的 Key 可能是部署时生成，后失效

#### 2. GHA 部署脚本脆弱
- `deploy-functions.sh` 用 `curl -sf`（失败立即退出）
- 无 retry 或错误容忍机制
- Step 4 失败导致 Step 5 完全跳过

#### 3. 验证周期太长
- 本地无法完整测试（需要 InsForge + PostgREST + PostgreSQL 完整栈）
- push → GHA → 服务器验证，单次验证 30分钟-2小时
- 失败后诊断困难（SSH 查日志，多层调用链）

#### 4. 幂等设计缺失
- 迁移文件不幂等（trigger 重复创建、INSERT 无 ON CONFLICT）
- function 部署逻辑判断 POST/PUT，但 curl 404 检测可能失败

#### 5. 环境变量碎片化
- `INSFORGE_API_KEY` 在 `deploy/.env`（后端调用）
- `INSFORGE_API_KEY` 需注入 web 容器（SDK 使用）
- `NEXT_PUBLIC_INSFORGE_ANON_KEY` 前端专用
- 新增功能漏配变量就出问题

---

### 改进措施

#### 立即可做

**1. 迁移文件强制幂等模板**（已创建 `database/MIGRATION_TEMPLATE.md`）
```sql
-- 标准模板
DROP TRIGGER IF EXISTS xxx ON table;
CREATE TRIGGER xxx ...

INSERT INTO table (...) VALUES (...) ON CONFLICT (id) DO UPDATE SET ...;
```

**2. VARCHAR 字段统一大长度**
- 编号/编码：VARCHAR(200)
- 名称：VARCHAR(500)
- 类别/分类：VARCHAR(200)
- 状态/类型：VARCHAR(50)

**3. 本地快速测试脚本**
```bash
# 不走 GHA，直接在容器内测试
ssh server "docker exec deploy-web-1 node -e '<测试代码>'"
```

#### 中期改进

**4. 统一环境变量管理**
- 所有变量集中在 `deploy/.env`
- `docker-compose.prod.yml` 只引用 `${VAR}`
- 新增功能检查清单：后端 env + 前端 env + 容器注入

**5. GHA 部署容错**
- function 部署失败不阻断前端构建
- 关键步骤加 retry（3 次，间隔 5s）
- 失败时输出详细错误（不吞 `curl` 输出）

**6. InsForge API Key 自愈**
- 检测 Key 无效时自动重新生成
- 或部署脚本从 Dashboard 获取最新 Key

#### 长期改进

**7. 本地开发环境镜像生产**
- `docker-compose.dev.yml` 模拟完整栈
- 本地能测完整流程再 push

**8. 数据库 Schema 类型生成**
- 从 PostgreSQL 生成 TypeScript 类型
- 避免 VARCHAR 长度反复修改

---

### 新增功能开发检查清单

**代码开发**
- [ ] 迁移文件用幂等模板
- [ ] **外部系统数据字段用 TEXT，不要用 VARCHAR**
- [ ] 环境变量：后端 + 前端 + 容器注入

**本地验证**
- [ ] TypeScript 编译通过
- [ ] 迁移 SQL 语法正确
- [ ] 新增 API 路由存在

**部署验证**
- [ ] GHA 成功（5 steps 全绿）
- [ ] 容器镜像已更新（时间戳检查）
- [ ] 新功能可访问

**数据验证**
- [ ] 数据写入正确
- [ ] 权限正确（anon/authenticated）
- [ ] RLS 策略（如需要）

---

### 关键教训

| 问题 | 教训 |
|-----|-----|
| 迁移文件不幂等 | 所有 DDL 必须先 `DROP IF EXISTS` / `IF NOT EXISTS` |
| VARCHAR 反复改 | **外部系统数据一律用 TEXT，VARCHAR 只用于自己控制的枚举字段** |
| 环境变量漏配 | 新增功能必须检查三处：后端 env、前端 env、容器注入 |
| GHA 失阻断整个部署 | 关键步骤加容错，失败不阻断后续步骤 |
| 容器跑旧代码 | 部署后必须检查容器创建时间 vs 镜像构建时间 |
| API Key 无效 | 部署脚本检测 Key 有效性，无效时自动获取新 Key |
| nginx 配置语法错误 | location 必须在 server block 内，不能独立成文件 |
| PostgREST schema 缓存 | 修改表结构后必须重启 PostgREST |

## Design System

**做任何视觉/UI 决策前先读 `DESIGN.md`。** 字体/色彩/间距/美学/报表特定约定全在那里定义。

- 字体：DM Sans + tabular-nums（数据对齐）
- 色彩：主色深蓝 #1E40AF + slate 中性 + 达成三色（绿/琥珀/红）
- 美学：Industrial/Utilitarian（专业经营分析，Tableau/PowerBI 同源）
- 报表中心：KPI 三段式 + 类Excel交叉表（tabular-nums+维度切换+下钻+合并单元格）+ 达成率三色编码 + 每组件 ⬇Excel/🖼图片/🔗分享
- 未经用户同意不要偏离 DESIGN.md。QA 时标记不符合 DESIGN.md 的代码。
