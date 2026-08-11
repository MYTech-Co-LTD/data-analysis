# 插件模板指南（collector / job / board / function）

> 状态：操作手册（v1）· 2026-08-12
> 依据：`docs/superpowers/specs/2026-08-11-modular-plugin-design.md` §4.3（插件机制与契约）、§4.4（依赖方向）、§6（并行切分五原则 + 合并协议）。
> 读者：并行实现阶段各模块 agent（Wave 1 jobs / Wave 2 functions / Wave 3 boards / 新数据源 collector）。
> 定位：给出「新插件怎么加」的最小模板 + 写集规则。契约改动不属本手册范围——改契约必须单独提 issue 走架构 owner review（spec §6.1 原则 1）。

---

## 1. 总览：四类插件

| 插件类型 | 契约（单源，web/lib/contracts） | 新插件放哪 | 注册表（唯一公共追加点） | 宿主 |
|---|---|---|---|---|
| Job（定时/事件任务） | `job-types.ts` → `JobManifest` | `web/lib/jobs/<id>/manifest.ts` | `web/lib/jobs/registry.ts` 的 `JOBS` 数组 | 薄 scheduler（按 `manifest.schedule` 注册 cron） |
| Collector（数据源采集） | `collector-types.ts` → `Collector` | `web/lib/collectors/<source>/` | `web/lib/collectors/registry.ts` 的 `COLLECTORS`（`kind` 主键） | 采集入口 / collect job（`COLLECTORS[kind].collectOnce`） |
| Board（报告板块） | `board-types.ts` → `BoardManifest<TRow>` | `web/lib/report-center/boards/<id>/` | `web/lib/report-center/boards/registry.ts` 的 `BOARDS` 数组 | 目标看板页（`app/reports/targets/[id]/page.tsx`） |
| Function（Edge Function） | `functions/<slug>/function.json`（manifest） | `functions/<slug>/index.js` | 无注册表——manifest 驱动部署 | InsForge Deno 运行时（`scripts/deploy-functions.sh` 部署） |

> 契约单源：`web/lib/contracts/index.ts` 是 barrel，只 re-export `job-types.ts` / `collector-types.ts` / `board-types.ts`。插件只 import 契约，**禁止**改契约文件。

---

## 2. 写集规则（spec §6.1，必须遵守）

1. **文件级写不重叠**：每个任务明确「我写哪些目录、哪些文件」。注册表文件是**唯一的公共追加点**，且只允许**尾部追加一行**。
2. **契约先冻结再放人**：新插件只**消费** `web/lib/contracts`，不得修改；需要改契约 = 单独提 issue 走架构 owner review。
3. **每模块自带测试**：vitest 单测（DI 注入 fake db/duck/notify），无 DB/网络可跑；CI 的 quality job 会跑 `cd web && npm test`（当前 42 文件 / 309 用例全绿）。
4. **小步提交、独立合并**：粒度 ≤ 400 行新增（搬移类 ≤ 1000 行但必须标注「纯搬移」）；PR 按模块边界命名（`feat(collectors/meituan)`）。
5. **依赖方向由 CI 兜底**：eslint `import/no-restricted-paths` 已严执（spec §4.4），破坏依赖方向在 CI 即失败。

### 2.1 依赖方向铁律（spec §4.4）

- `plugins ──► contracts` 单向；**插件之间禁止互相 import**（job 之间、collector 之间、board 之间）。
- 宿主（scheduler / dashboard / deploy）──► contracts + registry；宿主不 import 具体插件实现（只经注册表）。
- `contracts` 是叶子包：不 import 任何业务模块。
- 注册表是插件唯一的"互相见面"点——宿主从注册表取全部插件，插件彼此无感。

---

## 3. Job 插件模板

新 job = 新目录 `web/lib/jobs/<id>/` + 注册表尾部追加 1 行。

```ts
// web/lib/jobs/<id>/manifest.ts
import type { JobManifest, JobResult } from '../../contracts';

export const myJobManifest: JobManifest = {
  id: '<全局唯一 id>',          // 注册表主键；固定清单 job 全部在此登记
  schedule: '33 4 * * *',      // cron；缺省 = 手动/事件触发
  // dependsOn?: string[];     // 依赖的其它 job id（可选）
  run: async (): Promise<JobResult> => {
    // 函数体从 scheduler.ts 原样搬入（纯搬移，不改进）；锁/水位线机制随 job 搬迁：
    //   runningTasks + tryAcquireLock + params.watermark（参考 web/lib/jobs/carry-dims/manifest.ts）
    return { status: 'ok' };
  },
};
```

注册表追加（`web/lib/jobs/registry.ts`）：

```ts
import { myJobManifest } from './<id>/manifest';
export const JOBS: JobManifest[] = [
  // ...现有 job...
  myJobManifest,   // ← 尾部追加 1 行
];
```

> 动态采集任务（`collect_tasks` 每行一个 manifest）不在此列——宿主查询后经 `collectManifest(task)` 工厂逐个注册（见 `web/lib/jobs/collect/manifest.ts`）。

---

## 4. Collector 插件模板

新数据源 = 新目录 `web/lib/collectors/<source>/` + 注册表尾部追加 1 行。

```ts
// web/lib/collectors/<source>/index.ts
import type { Collector, CollectCtx, CollectOptions, CollectResult } from '../../contracts';

export const mySourceCollector: Collector = {
  kind: '<source>',   // 'lemeng' | 'meituan' | ...（注册表主键）
  async collectOnce(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
    // ctx：宿主注入认证令牌/companyId/task/来源特有配置；插件禁止自行建 client / 读参数之外秘密
    // opts：mode('full'|'incremental') / watermarkLastCount / dates / 来源特有运行参数
    return {
      // 完整性五要素（CLAUDE.md 铁律，缺一不可）：
      fetchComplete: true,      // ① 累计拉取数 ≥ 源 total
      upsertFailures: 0,        // ② upsert 批失败条数（parquet 型来源 = 0）
      verified: true,           // ③ fetchComplete && upsertFailures===0 && 库内 active ≥ 源 total
      softDeleteApplied: false, // ④ 本次是否执行全量先标 is_active=false 再回标
      alert: false,             // ⑤ verified=false 应记 collect_logs failed 并接入 collect_fail 告警
      // detail: <源结果全字段透传>   // 宿主取水位线/对账明细从 detail 读
    };
  },
  // count?(ctx, dates): Promise<number>   // C0 对账用，无此能力可不实现
  // sum?(ctx, dates): Promise<number>     // P2a 金额对账用，无此能力可不实现
};
```

注册表追加（`web/lib/collectors/registry.ts`）：

```ts
import { mySourceCollector } from './<source>';
export const COLLECTORS: Record<string, Collector> = {
  lemeng: lemengCollector,
  '<source>': mySourceCollector,   // ← 尾部追加 1 行
};
```

> 参考：`web/lib/collectors/lemeng/index.ts`（纯接口适配层：入参归位 + 结果映射，不改采集业务逻辑）+ `web/lib/collectors/lemeng/__tests__/index.test.ts`（单测范例）。

---

## 5. Board 插件模板

新板块 = 新目录 `web/lib/report-center/boards/<id>/` + 注册表尾部追加 1 行。板块之间禁止互相 import（§4.4）。

```ts
// web/lib/report-center/boards/<id>/manifest.ts
import type { BoardManifest } from "@/lib/contracts";
import { MyDesktop } from "./desktop";

export const myBoard: BoardManifest<MyRow> = {
  id: "<id>",                                // 全局唯一，注册表主键
  serverGet: (targetId, opts) => getMyData(targetId, opts),  // SSR 取数，返回 GetterResult<MyRow>
  Desktop: MyDesktop,                        // React 组件，接收 BoardProps<MyRow>
  // Mobile?: MyMobile,                      // 缺省复用 Desktop 容器
  menuLabel: "我的板块",
};
```

```tsx
// web/lib/report-center/boards/<id>/desktop.tsx
import type { BoardProps } from "@/lib/contracts";

export function MyDesktop({ result, target, targetId, progress, targetMonth, isMobile }: BoardProps<MyRow>) {
  // result.status === 'error' 时显示模块失败占位（F1.3），不挂整页
  return <div>…</div>;
}
```

注册表追加（`web/lib/report-center/boards/registry.ts`，**渲染顺序 = 注册顺序**）：

```ts
import { myBoard } from "./<id>/manifest";
export const BOARDS: BoardManifest<any>[] = [
  // ...现有板块...
  myBoard,   // ← 尾部追加 1 行
];
```

> 参考：`web/lib/report-center/boards/kpi/manifest.ts`。宿主用 `Promise.allSettled` 并行取数 + 渲染，单板块失败不挂整页。

---

## 6. Function 插件模板

新 function = 新目录 `functions/<slug>/`（`index.js` 必带）+ `function.json` manifest（部署/契约描述，照 spec §4.3）。

```jsonc
// functions/<slug>/function.json
{
  "slug": "<slug>",                    // 全局唯一
  "runtime": "commonjs",
  "secrets": ["WECOM_CORP_ID", "..."], // function 内 Deno.env.get 读取；由 deploy-functions.sh 注入
  "schedule": null,                    // cron 或 null
  "contract": {
    "auth": "none|agent_api_key|...",
    "input": { "$schema": "...", "type": "object" },
    "response": { "200": { "type": "object" } }
  }
}
```

```js
// functions/<slug>/index.js —— JavaScript 文件必须有 CommonJS 导出
module.exports = async function (request) { /* … */ return new Response(…); };
```

### 6.1 共享代码打包（引用 `_shared` 时必读）

- 运行时是**单文件模型**，function 无法 `require` 目录外模块。
- 若引用 `../_shared/`：部署脚本 `scripts/deploy-functions.sh` 先 esbuild bundle 成单文件，产物选择顺序：
  1. 本机 `npx esbuild --bundle --format=cjs` 现场 bundle（首选）；
  2. 已提交的 `functions/<slug>/index.bundle.js`（服务器无 node/npx 时回退）；
  3. 两者都不可用 → 跳过该 function 并报错（**绝不部署含 `require('../_shared/..')` 的裸源码**）。
- 未引用 `_shared` 的 function 直接部署 `functions/<slug>/index.js`。
- 改完 function 后提交前必跑 `bash scripts/check-functions.sh`（CI quality job 也会跑）。

---

## 7. 测试规范

- 每个新插件模块至少 1 个 vitest 单测，放 `web/lib/<...>/__tests__/`；宿主依赖（db/duck/notify）一律 DI 注入 fake，无 DB/网络可跑。
- 本地验证：`cd web && npm test`（CI quality job 同命令，当前 309 用例全绿必须保持）。
- 参考范例：`web/lib/collectors/lemeng/__tests__/index.test.ts`。

---

## 8. 提交 / 合并协议（spec §6.3）

1. 分支命名：`feat/<module>/<thing>` / `refactor/<module>/<thing>`。
2. 每个 PR 必须：CI 绿（lint + tsc + test + 契约漂移 + guard）+ 无跨写集文件改动；若动 `web/lib/contracts` 需架构 owner 显式 approve（默认拒绝）。
3. 注册表「尾部追加」设计：多个 PR 各自尾部追加行，git 通常能 auto-merge；冲突只是行序，秒级解决。
4. 合并顺序：先契约（Wave 0）→ Wave 1（jobs）→ Wave 2（functions）→ Wave 3（boards）。

---

## 附：关键文件索引

| 文件 | 作用 |
|---|---|
| `web/lib/contracts/index.ts` / `job-types.ts` / `collector-types.ts` / `board-types.ts` | 单源契约（只读） |
| `web/lib/jobs/registry.ts` | job 注册表（尾部追加） |
| `web/lib/collectors/registry.ts` | collector 注册表（尾部追加） |
| `web/lib/report-center/boards/registry.ts` | board 注册表（尾部追加） |
| `functions/<slug>/function.json` | function manifest（§4.3） |
| `scripts/deploy-functions.sh` | function 部署（_shared bundle 规则） |
| `scripts/check-functions.sh` | function 语法/结构检查（CI 必跑） |
| `.github/workflows/deploy.yml` | CI：quality（lint/tsc/vitest/function-check/guards）→ 部署拆步 |
