# 语义层 Cube 全替代设计（唯一手写层 = Cube schema；生成器按退役清单退出）

> 状态：设计待审（v2，取代同日 v1 的"自研编译器/双产出物"方案）· 2026-08-15
> 范围：Cube headless 成为查询引擎与语义定义唯一手写层；metric_registry 冻结新增、生成器按"物化上移 + 退役清单"退出；看板 boards 配置化；AI 问数走枚举查询不写 SQL。
> 关联：[[2026-08-15-permission-three-layer-design]]（data_scopes/claims）、[[2026-08-15-novu-push-platform-design]]（push_variables 同源注册表）
> 决策升级链：2026-07-22 否决运行时引擎 → 2026-08-15 v1 双产出物共生 → 本 v2 全替代（终局：少一个自研组件、少一层编译、口径直书一处）

---

## 1. 决策与前提（三条已获用户确认的让步）

1. **报表可用性绑定 Cube 常驻**：迁移期旧视图+PostgREST 保留为逃生通道；Cube 单容器+自动重启，预聚合物化在 PG（`external=false`，无 Cubestore/Redis 依赖，源码验证）。
2. **行级权限执行点上移**：报表路径由 RLS/视图谓词改为 Cube securityContext + accessPolicy（应用层，`data_scopes` 同源喂数）；RLS 退守 PostgREST 管理/写路径。这是对"RLS 是不可绕过执行点"铁律的一次正式、明示的边界调整。
3. **QA 体系围绕 Cube 重建**：L2 EXPLAIN → `/v1/sql` 断言；C2 对账 → qa-runner 扩展"Cube 结果 vs 直查表 diff"。

## 2. 目标架构

```
【手写层·唯一】Cube schema YAML（git，一域一文件，PR 审口径）
   measures/dimensions/joins/timeDimensions/accessPolicy
        │
【引擎】Cube 容器（data-analysis 机，memory 队列）
   checkAuth 验现有 JWT_SECRET → securityContext = data_scopes resolver 产出
   /v1/load（受约束查询 JSON）+ /v1/meta（catalog）
        │
【消费】boards 表（查询 JSON + 4 通用组件）· AI query_metrics/list_metrics 工具
        │
【数据】PG 基表 + /compute 物化表（四个硬口径全部跑批期物化，见 §4）
        退役清单清空后：生成器 + metric_registry + 生成视图全部下线
```

与 v1 的差异：不再有"注册表→生成器→双产出"的间接层；Cube schema 即 metric_registry 的继任者。

## 3. Cube schema 规范（手写层的纪律）

- 一域一文件 `cube/schemas/<domain>.yaml`；命名 = metric_registry 现有 metric_code 平移（sale/delivery/outbound_amt/distribution_margin...），口径描述进 `description`（catalog 与 AI 用）。
- 行级：accessPolicy.rowLevel.filters 用 `securityContext.branch_nums/brands`（resolver 同源）；列级：memberMasking 按 `securityContext.can_see_cost`。
- 新增指标 = 新 YAML + PR（发版走现有 GHA：schema 目录挂载进 cube 容器 volumes）。
- 禁止：在 schema 写业务字面量以外的口径魔法——复杂口径一律去 /compute 物化（继承"反自由发挥"铁律精神）。

## 4. 四个硬口径的物化上移（跑批期解决）

| 原生成器能力 | 物化方案 | 抓手 |
|---|---|---|
| 目标窗口范围 join | /compute 产出 `achievement_daily`（目标×日），Cube 等值 join | report_definitions 加模板 |
| lateral_pick 跨账套归码 | 跑批归对 item_code 后落表 | 迁移 157 的 pos_item_code 提取已有 |
| FULL JOIN 商品视图 | /compute 产统一宽表 `report_item_daily` | DELETE-before-INSERT 现模式 |
| closed 目标冻结 | close_target 写死进物化表 | target_snapshots 已有 |

## 5. 消费层

- **boards**：`boards(id, code, title, layout, queries JSONB[{component, cubeQuery, props}], enabled)`；4 通用组件（KPI卡/趋势/交叉表/达成表，DESIGN.md 约定）经 `@cubejs-client/core` SSR 预取。新建看板 = INSERT 一行。
- **AI 问数**：data-query-plugin 增 `query_metrics({metrics,dimensions,time,filters})`（参数只能引用 /v1/meta 枚举，非法组合 validate 期拒绝）+ `list_metrics()`。raw SQL 仅保留明细探索（§4.2 权限视图不变）。
- **推送**：push_variables 的 query_def 改为引用 Cube query（渲染引擎经 Cube 取数，同一路径同一次裁剪）。

## 6. 实施步骤（退役清单驱动，无大爆炸）

| 阶段 | 内容 | 验收 |
|---|---|---|
| C1 | Cube 容器部署 + checkAuth 接现有 JWT + resolver 产出 securityContext（依赖权限 spec P1-P2） | demo 指标按不同 claims 出不同行 |
| C2 | schema 骨架 + 3 个简单指标（sale/delivery/outbound_amt）直写 Cube | C2 对账：Cube vs 视图直查 diff=0 |
| C3 | boards 表 + 4 通用组件 + 首个看板迁移试点 | 试点页与旧页渲染一致 |
| C4 | AI query_metrics/list_metrics 接入 + skill 改写 | 三类问数端到端，口径零幻觉 |
| C5+ | 硬口径逐个物化上移（每季 1-2 个）：compute 模板 → Cube schema → 对账 → 切前端 → **生成视图从退役清单划掉** | 单口径全链路 diff=0 后才删视图 |
| 终点 | 退役清单清空 → 下线生成器 + metric_registry + database/generated | 首页/全部看板走 Cube ≥1 个月无回退 |

## 7. 非目标

- 不改采集与 /compute 管线（Duckle/乐檬另案）。
- 不启 Cubestore/预聚合（数据量不需要，`external=false` 留 PG）。
- 不动 §4.2 明细问数（agent-query raw SQL + 权限视图）。
- 不做看板拖拽编辑器（boards 先 DB/AI 生成）。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Cube 容器故障 = 报表全挂 | 自动重启 + 迁移期保留视图逃生通道 + service_down 探活 |
| securityContext 与 RLS 裁剪不一致 | C2 对账覆盖多角色 claims 矩阵；data_scopes 单源同喂 |
| schema 手写口径走样（继承"自由发挥"风险） | PR review + description 必填 + 复杂口径强制走物化的纪律 |
| Cube 上游演进（Redis 移除/tesseract 重写） | 锁定已验证版本升级；视图逃生通道在整个退役期内存在 |
