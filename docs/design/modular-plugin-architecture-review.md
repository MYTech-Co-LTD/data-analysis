# 模块化重构 · 架构评审材料

> 用途：供 `docs/architecture.md` §十二 架构变更流程 **step 3（征得用户同意）** 评审用。
> 评审对象：`docs/superpowers/specs/2026-08-11-modular-plugin-design.md`（A+B-lite，P0–P5 全景）。
> 结论预览：**主体不构成架构变更**（不改 §九 任一决策、不改服务拆分/数据流/技术栈/存储）；仅 P3/P5 涉部署链路内部实现，需在 architecture.md 补记录。

---

## 0. §十二 流程映射

| §十二 步骤 | 状态 | 产物 |
|---|---|---|
| 1. 发现需要变更的需求 | ✅ | scheduler 上帝模块 / 契约漂移 / function 样板重复等（spec §1.4） |
| 2. 提出变更方案 + 方案对比 + 推荐理由 | ✅ | spec §3（A/B/C 三方案）+ §4（A+B-lite 推荐 + 理由） |
| **3. 征得用户同意** | ⏳ **本次评审** | 本材料 + 用户拍板 |
| 4. 更新此架构文档 | 待 step 3 通过 | 见 §5 建议更新草稿 |
| 5. 执行代码实现 | 待 step 4 | 后续 writing-plans（P0 先行） |
| 6. 验证变更效果 | 待 step 5 | 各 Phase 的验证项（spec §5） |

**关键判断**：step 4「更新架构文档」是否必须，取决于本重构是否构成「架构变更」。本材料 §2/§3 给出逐条对照结论。

---

## 1. 评审范围（spec 的动作清单）

| 动作 | spec Phase | 摘要 |
|---|---|---|
| A 建 `web/lib/contracts/` 契约包 | P0 | qa-types/detail-sources/qa-checks 单源 + CI 漂移检查 |
| B qa-types 对齐止血 | P0 | C6/sum_col 保留、CheckResult 归运行时 |
| C `scheduler.ts` 拆 `jobs/*` | P1 | 纯搬移，scheduler 变薄（加载 registry + 锁） |
| D `collectors/` 插件化 | P2 | collect*.ts 归 `collectors/lemeng/` + registry 分发 |
| E `functions/_shared/` + esbuild bundle + `function.json` | P3 | 共享代码构建期打进单文件；manifest 驱动部署 |
| F `report-center/boards/` 注册表 | P4 | 7 板块封装，dashboard 页注册表驱动渲染 |
| G CI 每模块独立 job + 部署可选拆步 | P5 | migrate/function/web 互不阻断 |
| H 废弃/重写 `functions/mcp` 占位 | P3 | 与 agent-query 对齐 |

---

## 2. 逐动作 × 架构红线对照

> 红线来源：`docs/architecture.md` §九（26 条已确认决策）+ §一~四（部署单元/服务拆分）+ §1.2/§五/§十（数据流）+ 技术栈 + 存储。

| 动作 | §九 决策 | 服务拆分 | 数据流 | 技术栈 | 存储 | 判定 |
|---|---|---|---|---|---|---|
| **A 契约包** | 不改任一条 | 不加容器/服务 | 不改 | 不加运行时依赖 | 不动 | ✅ 纯代码组织 |
| **B qa-types 止血** | 不改 | 不改 | 不改 | 不改 | 不动 | ✅ 修已有 bug |
| **C scheduler 拆 jobs** | 「定时调度位置 node-cron（Next.js 内）」「scheduler 自初始化 instrumentation+globalThis 单例」**均保留** | 不改（仍在 web 容器） | 不改 | 不改 | 不动 | ✅ 保留机制，仅内部分文件 |
| **D collectors 插件化** | 「采集逻辑位置」「鉴权归属（数据源层）」「数据源粒度(外部系统,品牌)」**均保留** | 不改 | 不改（采集→parquet→compute→PG 链路不变） | 不改 | 不动 | ✅ 仍是 web 内采集 |
| **E functions bundle+manifest** | 「InsForge 核心栈」「Deno Runtime」运行时模型**不变**（单文件部署保留） | 不改部署单元 | 不改 | **引入 esbuild（构建期工具，非运行时框架）** | 不动 | ⚠️ **部署链路内部实现变更**——产物形态从「手写单文件」变「esbuild 打包单文件」，需 arch 记录 |
| **F boards 注册表** | 不改 | 不改 | 不改（视图→前端链路不变） | 不改 | 不动 | ✅ 纯前端代码组织 |
| **G CI/部署拆步** | 不改决策 | 不改单元 | 不改 | 不改 | 不动 | ⚠️ **部署链路描述变更**——如实施，CI 从全量单发改分步，需 arch 记录 |
| **H 废弃 mcp** | 「OpenClaw 集成 skill+tool→agent-query→/query」**保留**；mcp 本是占位 | 不改 | 不改 | 不改 | 不动 | ✅ 清理死代码（mcp 与 agent-query 重叠） |

**生成器铁律（§10.10）**：spec 的 `report-view-contract.ts` 只描述生成器**产出**的契约，不改「新增指标=改 registry AST、新增视图=改 view-configs」。✅ 不触及。

---

## 3. 评审结论

1. **主体（A/B/C/D/F/H + 契约/目录/注册表规范）不构成架构变更**：不改 §九 任一已确认决策、不加部署单元、不改数据流、不加运行时框架、不改存储。属于「代码组织 + 内部实现」重构，§十二「禁止行为」（未更新文档改代码 / 擅自改服务拆分或数据流向）均不触发。
2. **仅 P3（E）与 P5（G）涉及部署链路内部实现**：function 构建产物形态变化（esbuild bundle）、CI 部署节奏变化（拆步）。这两项建议在 architecture.md 补记录（见 §5），但**不改运行时架构、不改部署拓扑**。
3. **建议在 §九 决策表补一行「代码组织规范」**：确立 A+B-lite（目录即模块 + 注册表插件 + 契约单源）为平台代码组织约定，避免未来 agent 不知规范、各自发挥。这是「新增一条架构决策」，符合 §十二 step 4。
4. **qa-types 漂移止血（B）是修已有 bug**，独立于模块化，可单独先行——但因其正是 P0 契约单源的第一步，合并进 P0 执行即可。

> 一句话：本重构无需改架构红线，只需 step 4 在 architecture.md 补「代码组织决策」+「P3/P5 部署链路实现说明」两类记录。

---

## 4. 需评审人拍板的决策点

| # | 决策点 | 推荐 |
|---|---|---|
| D1 | 同意 A+B-lite 选型（不引入运行时插件框架、不拆服务）？ | 推荐（规模决定，spec §4.1 论证） |
| D2 | P3 functions 引入 esbuild bundle + `function.json` manifest，改 function 构建产物形态——同意？ | 推荐（先试点 1 个 function 全绿再铺开，保留旧脚本回退） |
| D3 | P5 CI/部署拆步（migrate/function/web 互不阻断）——现在做还是延后？ | 建议延后到 P0–P4 稳定后（P5 非必须，spec 已标可选） |
| D4 | 在 §九 决策表补「代码组织：A+B-lite」一行——同意？ | 推荐（确立规范，防未来发挥） |
| D5 | qa-types 单源合并方向：C6 保留、sum_col 保留、CheckResult 归运行时类型——确认？ | 推荐（实测两侧均在使用，见 spec §1.6） |
| D6 | pnpm workspace 做不做（影响 P0 契约共享实现）？ | 建议不做（复制+CI 守，零风险），P0 启动前终评 |

---

## 5. architecture.md 建议更新草稿（评审通过、step 4 执行）

**① §九 决策表追加一行**：

```
| 代码组织规范 | A+B-lite：目录即模块 + 尾部追加式注册表 + 契约单源（web/lib/contracts）；不引入运行时插件框架、不拆服务 | 2026-08-11 |
```

**② function 构建说明（P3 落地时，补在 §1.4 Deno Runtime 或部署相关节）**：

```
- function 构建：functions/_shared/（jwt/cors/wecom-client/postgrest-client）经 esbuild bundle 打进各 function 单文件；
  每个 function 配 function.json manifest（secrets/schedule/输入输出契约），deploy-functions.sh 按 manifest 校验/部署。
  运行时模型不变（仍是 InsForge Deno 单文件部署）。
```

**③ CI/部署拆步（P5 落地时，若实施则补；不实施则不补）**：

```
- 部署链路：migrate / function / web 可独立 CI job，互不阻断（function 部署失败不阻断前端构建）。
```

**④ §十一 待讨论表更新**（可选）：

```
| 模块化+插件化重构 | ✅ 已设计（spec 2026-08-11） | P0–P5 分阶段，P0 先行 |
```

---

## 6. 评审通过后的下一步

1. 执行 §5 的 architecture.md 更新（step 4）。
2. P0 起 writing-plans（契约包 + qa-types 止血 + 单源 + CI 漂移检查）。
3. P1–P5 各自后续 plan，每 phase 落地前若触及部署链路（P3/P5）再回到本评审材料核对。
