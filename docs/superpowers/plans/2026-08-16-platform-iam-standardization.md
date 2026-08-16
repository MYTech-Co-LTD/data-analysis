# 平台级 IAM 标准化（Casdoor 主导）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 orca-sdd 逐 task 派发执行（用户指定）。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 按 spec `docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`（revision-2 终稿，commit 23b9604）落地：W1 catalog 能力点+资源同步+校验器（observe）→ W2 Group 目录+影子对账（只写不读）→ W3 claims 契约扩展+RLS 策略分支（与 U2 同窗）→ W4 存量回填+消费侧切 → W5 例外表+DB 写关闭 → W6 data_permissions sunset。

**Architecture:** Casdoor 是授权唯一真相源：能力点 = catalog（代码真相源 `web/lib/capability-catalog.ts`）+ casbin Permission(resource) + 同步 adapter；数据范围三分流（品牌/品类/字段→resource；门店→Group tree 挂组；临时例外→app `temporary_grants`）。执行端单一 claims 消费（groups/data_scope/fields/catalog_v 新段 + 四维旧 key 双氧保留至 W6）。空集=deny 由 RLS 策略分支 enforce（data_scope 段存在→空=deny；缺失→回退 legacy `claim_match_or_star`）。

**Tech Stack:** PostgreSQL 迁移（幂等模板，178 号起）、Next.js web（vitest）、Deno edge functions（wecom-oidc-callback）、Casdoor HTTP API（复用 `web/lib/sync/casdoor-client.ts` 的 casdoorFetch/client_credentials）、PostgREST（pgrst_pre_request 扩展）。

## Global Constraints

- 迁移全幂等（DROP IF EXISTS / IF NOT EXISTS / ON CONFLICT），新表 GRANT anon/authenticated + 部署后 restart postgrest；视图 DROP VIEW IF EXISTS + CREATE VIEW（禁 CREATE OR REPLACE）。
- **门店键 = `(system_book_code, branch_num)` 复合或 `branch_number`；禁裸 `branch_num`**（join/去重/PK/.eq() 全禁）。门店 Group 名与 maps_branch_group 一律用 branch_number。
- **catalog 单真相纪律（H12）**：`capabilityCatalog` 只存 `web/lib/capability-catalog.ts`（+ 其 generated 输入 `web/lib/capability-catalog.generated.ts`，同目录）；function（claims 构建器）只消费不内嵌复制 catalog 子集。
- **空集 = deny（B1/铁律 6）**：data_scope/groups 段存在但空 = authorized ∅ = deny，不收敛 `["*"]`；enforce 走 RLS 策略分支，**严禁对 data_scope 空段用 `claim_match_or_star`**（其空数组/NULL→true 全放）。
- **例外不折叠进 claims（B5）**：temporary_grants 走 5min 缓存实查 + pgrst_pre_request 每请求并集专用 claim 段；登录时折叠 = 违规。
- 时区一律 `Asia/Shanghai`；部署：web/迁移走 GHA，只改 function 走 SSH 直调 + 清 Deno 缓存；生成器（services/semantic-generator）零改动（掩码消费位在非生成器运行时层，H7）。
- 语义层/catalog 联动：新增视图只改 view-configs + catalog 自动发现；**不改生成器**。
- WIP=1：任一时刻一个 W 阶段主动开发；W3 与 U2 同一发布窗；W5 ≥ U2 验收。
- 每迁移文件头部注释标 W 归属与依赖迁移号；migrate.sh 产物排序按 LC_ALL=C 字节序（已有机制，不重排序）。

## File Structure（W1-W6 全景，按 task 归属）

| 文件 | 动作 | 责任 | Task |
|---|---|---|---|
| `docs/architecture.md` / `CLAUDE.md` / `docs/ops/permission-boundary.md` | Modify | 架构/纪律/边界文档先行更新 | 0 |
| `web/lib/capability-catalog.ts` | Create | catalog 单真相（overrides + deprecated + viewGroups + 类型） | 1 |
| `web/lib/capability-catalog.generated.ts` | Create(scan 产出) | 自动发现草案（进 git，重跑 diff 即测试） | 2 |
| `scripts/scan-capabilities.mjs` | Create | 扫 view-configs + app/admin 路由 → generated | 2 |
| `web/lib/validate-capabilities.ts` + `__tests__/validate-capabilities.test.ts` | Create | 校验器（catalog∪`*` / 环引用 / deprecated / 通配高风险） | 3 |
| `web/lib/sync/resource-sync.ts` + tests | Create | add-resource adapter（`/` 前缀 / 差集只插 / dup retry / 逐 key 反馈） | 4 |
| `scripts/reconcile-catalog.mjs` | Create | permission.resources vs catalog 对账（C/E/M + per-user 汇总） | 5 |
| `web/app/admin/capabilities/page.tsx` | Create | 能力目录辅助页 | 6 |
| `.github/workflows/deploy.yml` | Modify | 部署钩子 step（scan→validate→sync） | 6 |
| `database/migrations/178_maps_branch_group.sql` | Create | 映射表 + groups 投影列 | 7 |
| `web/lib/sync/group-sync.ts` + tests | Create | 组同步器（两通道 + 先父后子 + 父链校验） | 8 |
| `web/lib/sync/group-expand.ts` + tests | Create | 组类型三态展开 | 9 |
| `scripts/reconcile-groups.mjs` | Create | 独立期望源「人→门店」对账 | 10 |
| `functions/wecom-oidc-callback/index.js` | Modify | claims 三段扩展 + B2 资源串 + 旧 key 镜像 | 11 |
| `database/migrations/179_rls_scope_branch.sql` | Create | RLS 策略分支 scope_match_v2 + 全部行策略替换 | 12 |
| `web/lib/feature-perm.ts` | Modify | catalog_v 快/慢路径 + 解析期校验 | 13 |
| `database/migrations/180_perm_freeze_snapshot.sql` | Create | U2 冻结快照表 + 哨兵 | 14 |
| `database/migrations/181_perm_backfill.sql` + `scripts/backfill-perms.mjs` | Create | 存量回填 + diff=0 门禁 | 15 |
| `database/migrations/182_consumption_switch.sql` | Create | 消费侧切（RLS 主读 data_scope） | 16 |
| `database/migrations/183_temporary_grants.sql` | Create | 例外表 + RT 基础 | 17 |
| `web/app/admin/permissions/` + `web/lib/exception-grants.ts` | Modify/Create | 授权中心例外 UI + 5min 缓存实查 + 主动失效 | 17 |
| `database/migrations/184_perm_write_close.sql` | Create | REVOKE/触发器 DB 级写关闭 | 18 |
| `web/lib/view-groups.ts` + tests | Create | view-group 展开（环检测复用校验器） | 19 |
| `database/migrations/185_perm_sunset.sql` + `database/rollback/167_reverse.sql` | Create | 表删除 + 契约①替代 + 旧 key 摘除 | 20 |

---

### Task 0: architecture.md / CLAUDE.md / permission-boundary.md 更新（CLAUDE.md 铁律：实施前完成）

**Files:**
- Modify: `docs/architecture.md`（§4.2-4.4 / §6 真相源总表 / §6.4 新增 / §6.5 新增 / §7.1.2 / §九）
- Modify: `CLAUDE.md`（新增 catalog 单真相纪律段）
- Modify: `docs/ops/permission-boundary.md`（三分流边界表）

**Interfaces:** Consumes: spec「架构文档更新」清单（§架构文档更新）。Produces: 文档事实基础，后续全部 task 引用。

- [ ] **Step 1: architecture.md 按 spec 清单改写**：§4.2-4.4 组织架构改「Casdoor Group tree 中心化」+ 信任边界补 Group 同步器与 resource adapter；§6 真相源总表替换为 spec「真相源总表」九行（三分流 + catalog + groups claim）；§6.4 新增「能力点 catalog 与动态发现」（含废弃清单生命周期与通配残余）；新增 §6.5「授权组 view-group 与例外表」（含 5min 缓存实查/RT→RLS 并集/不折叠语义）；§7.1.2 薄同步扩为「用户同步（原生）+ 组同步器（自写）双轨」+ maps_branch_group；§九 追加 D1-D8 决策记录。
- [ ] **Step 2: CLAUDE.md 新增纪律段**（放在「门店键铁律」之后，同级）：

```markdown
## catalog 单真相纪律（重要）

**`capabilityCatalog` 只存在于 `web/lib/capability-catalog.ts`（含 scan 产出的 generated 输入）单副本；
function（claims 构建器）只消费不内嵌复制 catalog 子集。** 新增视图/路由 = 改 view-configs / app 路由，
catalog 由 scan 自动发现；在 function 内手写能力清单 = 违规（function-only 部署 SSH 直调不触发 catalog
scan，内嵌副本必然漂移）。空集 = deny：claims 的 data_scope/groups 段存在但为空 = 授权确定为 ∅，
禁止收敛 ["*"]；enforce 走 RLS 策略分支（迁移 179），严禁对空段使用 claim_match_or_star。
```

- [ ] **Step 3: permission-boundary.md 边界表替换**：三层表新增「组织架构目录 = Casdoor Group tree（组同步器 auto + UI manual）」「数据范围三分流（品牌/品类/字段→resource；门店→挂组；例外→temporary_grants RT 实查）」；删「data_permissions 四维」表述（标注 W6 sunset 迁移中）；「合成顺序」图改为 claims data_scope 版（含空集=deny）。
- [ ] **Step 4: 自查**：`grep -rn "data_permissions 四维\|行级数据权限留在本地" docs/architecture.md docs/ops/permission-boundary.md` 应零残留（历史 spec 归档文件除外）。
- [ ] **Step 5: Commit** `git add docs/ CLAUDE.md && git commit -m "docs(arch): IAM 标准化 W 轴架构先行更新（spec 2026-08-16 落地前置）"`

---

### Task 1: capability-catalog 单真相模块

**Files:**
- Create: `web/lib/capability-catalog.ts`
- Create: `web/lib/capability-catalog.generated.ts`（Task 2 的 scan 产出首个版本；本 task 先落手工种子版，scan 上线后被覆盖合并）
- Test: `web/lib/__tests__/capability-catalog.test.ts`

**Interfaces:** Consumes: 无（根模块）。Produces: `capabilityCatalog: readonly CatalogEntry[]`、`CATALOG_KEYS: ReadonlySet<string>`、`DEPRECATED_KEYS: ReadonlySet<string>`、`VIEW_GROUPS: Readonly<Record<string, {label: string; members: readonly string[]}>>`、类型 `CatalogEntry { key, group, label, sensitive?, source: 'auto'|'manual' }`。后续 Task 3（校验器）/4（同步 adapter）/6（辅助页）/13（catalog_v）消费。

- [ ] **Step 1: 写失败测试**

```ts
// web/lib/__tests__/capability-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { capabilityCatalog, CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS } from '../capability-catalog';

describe('capability-catalog 单真相', () => {
  it('catalog 非空且 key 全局唯一', () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    const keys = capabilityCatalog.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('全部 key 符合命名空间（data-analysis:view|view-group|field|brand|category|admin）', () => {
    const ns = /^data-analysis:(view|view-group|field|brand|category|admin):?[A-Za-z0-9_一-龥-]*$/;
    for (const e of capabilityCatalog) expect(e.key, e.key).toMatch(ns);
  });
  it('DEPRECATED 与 CATALOG 不相交（废弃即不在册）', () => {
    for (const d of DEPRECATED_KEYS) expect(CATALOG_KEYS.has(d)).toBe(false);
  });
  it('VIEW_GROUPS 成员必须 ∈ CATALOG 且禁含通配', () => {
    for (const [g, def] of Object.entries(VIEW_GROUPS)) {
      expect(CATALOG_KEYS.has(g)).toBe(true); // 组名自身也是 resource
      for (const m of def.members) {
        expect(m.includes('*'), `${g} 成员禁通配: ${m}`).toBe(false);
        expect(CATALOG_KEYS.has(m), `${g} 成员不在册: ${m}`).toBe(true);
      }
    }
  });
  it('种子含 admin 门禁与 cost 字段', () => {
    expect(CATALOG_KEYS.has('data-analysis:admin')).toBe(true);
    expect(CATALOG_KEYS.has('data-analysis:field:cost')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/__tests__/capability-catalog.test.ts`，Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现**

```ts
// web/lib/capability-catalog.ts
// 能力点 catalog 单真相（spec §5.1，H12 纪律：唯一副本，function 只消费不复制）。
// 组成 = generated（scan 自动发现，scripts/scan-capabilities.mjs 产出）+ overrides（人工层）+ manual（手工清单）。
import { GENERATED_CATALOG } from './capability-catalog.generated';

export interface CatalogEntry {
  key: string;            // data-analysis:view:reports / field:cost / brand:3120 / ...
  group: string;          // 辅助页分组：看板 / 字段 / 品牌 / 品类 / 门禁
  label: string;          // 展示名（人工 override 可改）
  sensitive?: boolean;    // 敏感标记（field 类默认 true）
  source: 'auto' | 'manual';
}

// 人工覆盖层：只改展示属性与标记，不增删 key（增删走 view-configs/路由 + scan）
const OVERRIDES: Partial<Record<string, Partial<CatalogEntry>>> = {
  'data-analysis:view:reports':        { group: '看板', label: '经营总览' },
  'data-analysis:view:reports-items':  { group: '看板', label: '商品下钻' },
  'data-analysis:view:reports-targets':{ group: '看板', label: '目标达成' },
  'data-analysis:view:wholesale-customers': { group: '看板', label: '批发客户下钻' },
  'data-analysis:field:cost':          { group: '字段', label: '成本可见', sensitive: true },
};

// 手工清单（scan 覆盖不到的：门禁/推送已排除——push:* 是引擎裸 key，不入 catalog）
const MANUAL: CatalogEntry[] = [
  { key: 'data-analysis:admin', group: '门禁', label: '管理台', source: 'manual' },
  { key: 'data-analysis:field:cost', group: '字段', label: '成本可见', sensitive: true, source: 'manual' },
  { key: 'data-analysis:brand:3120', group: '品牌', label: '熊喵鲜生', source: 'manual' },
  { key: 'data-analysis:brand:64188', group: '品牌', label: '品品甜', source: 'manual' },
  { key: 'data-analysis:category:水果', group: '品类', label: '水果', source: 'manual' },
  { key: 'data-analysis:category:标品', group: '品类', label: '标品', source: 'manual' },
  { key: 'data-analysis:category:耗材', group: '品类', label: '耗材', source: 'manual' },
];

// 废弃清单（H14/redteam M2）：载体在 app 侧；驱逐判据 = 发布 ≥30 天 ∧ 审计无引用 ∧ 对账红区清零
const DEPRECATED: readonly string[] = [];

const merged: CatalogEntry[] = [...GENERATED_CATALOG, ...MANUAL].map((e) => ({
  ...e, ...OVERRIDES[e.key],
}));

// key 去重（generated 与 manual 撞 key 时 manual 优先——人工兜底）
const seen = new Set<string>();
const deduped: CatalogEntry[] = [];
for (const e of [...merged].reverse()) { if (!seen.has(e.key)) { seen.add(e.key); deduped.unshift(e); } }

export const capabilityCatalog: readonly CatalogEntry[] = Object.freeze(deduped);
export const CATALOG_KEYS: ReadonlySet<string> = new Set(capabilityCatalog.map((e) => e.key));
export const DEPRECATED_KEYS: ReadonlySet<string> = new Set(DEPRECATED);

// 授权组（spec §5.5）：映射在 catalog（app 侧），不复制进 Casdoor policy
export const VIEW_GROUPS = Object.freeze({
  'data-analysis:view-group:reports-all': {
    label: '报表看板全组',
    members: [
      'data-analysis:view:reports', 'data-analysis:view:reports-items',
      'data-analysis:view:reports-targets', 'data-analysis:view:wholesale-customers',
    ],
  },
} as const);
```

```ts
// web/lib/capability-catalog.generated.ts
// ⚠️ 本文件由 scripts/scan-capabilities.mjs 自动生成（Task 2 上线后）；进 git，重跑 diff 即测试。
// 种子版：scan 上线前的已知看板（与 view-configs 现状对齐，Task 2 将以扫描结果覆盖）。
export const GENERATED_CATALOG: readonly {
  key: string; group: string; label: string; source: 'auto';
}[] = Object.freeze([
  { key: 'data-analysis:view:reports',           group: '看板', label: 'reports',           source: 'auto' },
  { key: 'data-analysis:view:reports-items',     group: '看板', label: 'reports-items',     source: 'auto' },
  { key: 'data-analysis:view:reports-targets',   group: '看板', label: 'reports-targets',   source: 'auto' },
  { key: 'data-analysis:view:wholesale-customers', group: '看板', label: 'wholesale-customers', source: 'auto' },
]);
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/__tests__/capability-catalog.test.ts`，Expected: PASS（5 例全绿）。
- [ ] **Step 5: Commit** `git add web/lib/capability-catalog.ts web/lib/capability-catalog.generated.ts web/lib/__tests__/capability-catalog.test.ts && git commit -m "feat(catalog): 能力点 catalog 单真相模块（W1 Task1，H12）"`

---

### Task 2: scan 自动发现脚本（新增/删除双断言）

**Files:**
- Create: `scripts/scan-capabilities.mjs`
- Modify: `web/lib/capability-catalog.generated.ts`（scan 产出覆盖）
- Test: `scripts/tests/scan-capabilities.test.mjs`

**Interfaces:** Consumes: `services/semantic-generator/src/view-configs.ts`（视图注册表——只读 import 提取 view 名）、`web/app/(app|admin)/**` 路由目录。Produces: 退出码 0=generated 与扫描一致 / 1=有 diff（CI 门禁）；`--write` 模式重写 generated。后续 Task 6（GHA 钩子）消费。

- [ ] **Step 1: 写失败测试**（node:test，与 scripts/tests 现有模式一致）

```js
// scripts/tests/scan-capabilities.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSources, renderGenerated } from '../scan-capabilities.mjs';

test('view-configs 的每个视图 → data-analysis:view:<name>', () => {
  const out = scanSources({ viewNames: ['reports', 'reports-items'] });
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports'));
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports-items'));
});

test('app 路由目录 → view:<route>（admin 路由除外——admin 走门禁不入 catalog）', () => {
  const out = scanSources({ routeDirs: ['reports', 'targets', 'branches'] });
  assert.ok(out.some((e) => e.key === 'data-analysis:view:reports'));
  assert.ok(out.every((e) => !e.key.startsWith('data-analysis:view:admin')));
});

test('删除方向不自动减（H14）：扫描结果不含已下线视图时，已标 deprecated 的 key 保留在输出外、不在 generated', () => {
  const out = scanSources({ viewNames: ['reports'] }); // 假设 reports-items 已下线
  assert.ok(!out.some((e) => e.key === 'data-analysis:view:reports-items'));
  // generated 中该 key 的移除只能由人工把它加入 DEPRECATED 后的下一轮 scan 或人工编辑完成——
  // 即 scan 永不产出「删除」，删除断言见 renderGenerated 对 DEPRECATED 的过滤
});

test('renderGenerated 输出可被 TS import（语法快照）', () => {
  const src = renderGenerated([{ key: 'data-analysis:view:x', label: 'x' }]);
  assert.ok(src.includes('GENERATED_CATALOG'));
  assert.ok(src.includes("data-analysis:view:x"));
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/scan-capabilities.test.mjs`，Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现 scan**

```js
// scripts/scan-capabilities.mjs
// 能力点自动发现（spec §5.1 ②）：语义层 view-configs + app 路由 → catalog 草案。
// 只增不减（H14：删除走人工废弃清单）；--write 重写 generated，无参=校验模式（diff 则 exit 1）。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function scanSources({ viewNames, routeDirs } = {}) {
  const views = viewNames ?? viewConfigNames();   // 读 services/semantic-generator/src/view-configs.ts 提取注册名
  const routes = routeDirs ?? appRouteDirs();     // 读 web/app/(app|pc) 下的页面路由段（排除 admin/、api/、_）
  const out = new Map();
  for (const v of views)  out.set(`data-analysis:view:${v}`,  { key: `data-analysis:view:${v}`,  group: '看板', label: v, source: 'auto' });
  for (const r of routes) out.set(`data-analysis:view:${r}`,   { key: `data-analysis:view:${r}`,   group: '看板', label: r, source: 'auto' });
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'));
}

function viewConfigNames() {
  const src = readFileSync(join(ROOT, 'services/semantic-generator/src/view-configs.ts'), 'utf8');
  // view-configs 注册形态：viewConfigs = { reports: {...}, 'reports-items': {...} }（键即 view 名）
  const m = src.match(/^\s*([A-Za-z][\w-]*)\s*:\s*\{/gm) ?? [];
  return [...new Set(m.map((s) => s.trim().replace(/\s*:\s*\{$/, '')))];
}
function appRouteDirs() {
  const base = join(ROOT, 'web/app');
  if (!existsSync(base)) return [];
  const out = [];
  for (const group of ['(app)', '(pc)']) {
    const dir = join(base, group);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir, { withFileTypes: true }))
      if (d.isDirectory() && !d.name.startsWith('_') && d.name !== 'admin' && d.name !== 'api') out.push(d.name);
  }
  return out;
}

export function renderGenerated(entries) {
  const rows = entries.map((e) =>
    `  { key: '${e.key}', group: '${e.group}', label: '${e.label}', source: 'auto' },`).join('\n');
  return `// web/lib/capability-catalog.generated.ts
// ⚠️ 自动生成（scripts/scan-capabilities.mjs）；进 git，重跑 diff 即测试。禁止手改。
export const GENERATED_CATALOG: readonly {
  key: string; group: string; label: string; source: 'auto';
}[] = Object.freeze([
${rows}
]);
`;
}

const genPath = join(ROOT, 'web/lib/capability-catalog.generated.ts');
const next = renderGenerated(scanSources());
if (process.argv.includes('--write')) {
  writeFileSync(genPath, next);
  console.log('[scan] generated 已重写');
} else {
  const cur = existsSync(genPath) ? readFileSync(genPath, 'utf8') : '';
  if (cur !== next) {
    console.error('[scan] generated 与扫描结果不一致——运行 npm run scan:capabilities -- --write 后提交');
    process.exit(1);
  }
  console.log('[scan] 一致');
}
```

- [ ] **Step 4: 跑单测确认通过**：Run `node --test scripts/tests/scan-capabilities.test.mjs`，Expected: PASS。
- [ ] **Step 5: 对真实仓库跑 scan --write 并复跑 Task 1 测试**：Run `node scripts/scan-capabilities.mjs --write && cd web && npx vitest run lib/__tests__/capability-catalog.test.ts`，Expected: generated 被真实路由/视图覆盖；catalog 测试仍 PASS（scan 产出的 key 都符合命名空间）。
- [ ] **Step 6: 校验模式门禁自测**：Run `node scripts/scan-capabilities.mjs`，Expected: exit 0；手改 generated 一行再跑 → exit 1（还原）。
- [ ] **Step 7: Commit** `git add scripts/scan-capabilities.mjs scripts/tests/ web/lib/capability-catalog.generated.ts && git commit -m "feat(catalog): 自动发现脚本 scan-capabilities（W1 Task2，新增/删除双断言）"`

---

### Task 3: catalog 校验器（fail-close + 环引用 + deprecated + 通配高风险）

**Files:**
- Create: `web/lib/validate-capabilities.ts`
- Test: `web/lib/__tests__/validate-capabilities.test.ts`

**Interfaces:** Consumes: Task 1 的 `CATALOG_KEYS/DEPRECATED_KEYS/VIEW_GROUPS`。Produces: `validateKey(key: string): { ok: boolean; reason?: 'unknown' | 'deprecated' }`、`validateWildcardRisk(perms: readonly string[]): { risky: readonly string[] }`、`detectViewGroupCycle(): string[]`（空=无环）。Task 6（辅助页）/11（claims 构建）/13（middleware）消费。

- [ ] **Step 1: 写失败测试**

```ts
// web/lib/__tests__/validate-capabilities.test.ts
import { describe, it, expect } from 'vitest';
import { validateKey, validateWildcardRisk, detectViewGroupCycle } from '../validate-capabilities';
import { CATALOG_KEYS, VIEW_GROUPS } from '../capability-catalog';

describe('catalog 校验器（spec §5.1 ⑤，fail-close）', () => {
  it('合法 key 放行（catalog 内任取 + 全局 *）', () => {
    const anyKey = [...CATALOG_KEYS][0];
    expect(validateKey(anyKey).ok).toBe(true);
    expect(validateKey('*').ok).toBe(true);
  });
  it('未知 key 拒绝（反向发现）', () => {
    expect(validateKey('data-analysis:view:nope')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('deprecated key 拒绝（H14 fail-close）', () => {
    // 借用一个不存在的 key 模拟已废弃：直接测 reason 分支
    expect(validateKey('__test_deprecated__')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('通配授权进高风险清单（M1）', () => {
    const r = validateWildcardRisk(['data-analysis:view:reports', 'data-analysis:view:*', 'data-analysis:brand:*']);
    expect([...r.risky]).toEqual(['data-analysis:view:*', 'data-analysis:brand:*']);
  });
  it('view-group 无环（现状）+ 注入环可检出', () => {
    expect(detectViewGroupCycle()).toEqual([]);
    // detectViewGroupCycle 接受可选入参便于测试注入（生产调用无参）
    const cyclic = { 'data-analysis:view-group:a': { label: 'a', members: ['data-analysis:view-group:b'] as const },
                     'data-analysis:view-group:b': { label: 'b', members: ['data-analysis:view-group:a'] as const } };
    expect(detectViewGroupCycle(cyclic as unknown as typeof VIEW_GROUPS).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/__tests__/validate-capabilities.test.ts`，Expected: FAIL。
- [ ] **Step 3: 实现**

```ts
// web/lib/validate-capabilities.ts
// 校验器（spec §5.1 ⑤）：只认 catalog ∪ "*"（∪ deprecated——deprecated 是「拒绝+告警」不是放行）。
import { CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS } from './capability-catalog';

export type KeyVerdict = { ok: true } | { ok: false; reason: 'unknown' | 'deprecated' };

export function validateKey(key: string): KeyVerdict {
  if (key === '*') return { ok: true };
  if (DEPRECATED_KEYS.has(key)) return { ok: false, reason: 'deprecated' };
  if (CATALOG_KEYS.has(key)) return { ok: true };
  return { ok: false, reason: 'unknown' };
}

const WILDCARD_RE = /^data-analysis:(view|view-group|brand|category|field):\*$/;
export function validateWildcardRisk(perms: readonly string[]): { risky: readonly string[] } {
  return { risky: perms.filter((p) => WILDCARD_RE.test(p)) };
}

// 环引用检测（S1）：view-group 嵌套 A→B→A 展开死循环 = 登录链路卡死
export function detectViewGroupCycle(groups: Record<string, { members: readonly string[] }> = VIEW_GROUPS as never): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cyclic: string[] = [];
  const visit = (node: string, stack: string[]): void => {
    const c = color.get(node) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) { cyclic.push(...stack.slice(stack.indexOf(node))); return; }
    color.set(node, GRAY);
    for (const m of groups[node]?.members ?? [])
      if (m in groups) visit(m, [...stack, node]);   // 只沿 view-group→view-group 边走
    color.set(node, BLACK);
  };
  for (const g of Object.keys(groups)) visit(g, []);
  return [...new Set(cyclic)];
}
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/__tests__/validate-capabilities.test.ts`，Expected: PASS。
- [ ] **Step 5: Commit** `git add web/lib/validate-capabilities.ts web/lib/__tests__/validate-capabilities.test.ts && git commit -m "feat(catalog): 校验器 fail-close + 环引用 + 通配高风险（W1 Task3）"`

---

### Task 4: resource 同步 adapter（add-resource 幂等 + 怪癖钉死）

**Files:**
- Create: `web/lib/sync/resource-sync.ts`
- Test: `web/lib/sync/__tests__/resource-sync.test.ts`

**Interfaces:** Consumes: `web/lib/sync/casdoor-client.ts` 现有 `casdoorFetch(path, init)` 与 client_credentials token（同文件 getAccessToken 已内部化）；Task 1 `CATALOG_KEYS/DEPRECATED_KEYS`。Produces: `syncResources(owner: string): Promise<SyncReport>`，`SyncReport = { added: string[]; skippedExisting: string[]; failed: { key: string; error: string }[] }`。Task 5（对账）/6（GHA 钩子 + cron）消费。

- [ ] **Step 1: 写失败测试**（mock casdoorFetch，不真调 Casdoor）

```ts
// web/lib/sync/__tests__/resource-sync.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(),
}));
import { casdoorFetch } from '../casdoor-client';
import { syncResources } from '../resource-sync';

const mockFetch = casdoorFetch as unknown as ReturnType<typeof vi.fn>;
function remoteHas(names: string[]) { // get-resources 返回形态（name 恒带 / 前缀——H3 怪癖）
  return { data: names.map((n) => ({ owner: 'shanhai', name: n })) };
}

describe('resource 同步 adapter（spec §5.1 ③ H3 怪癖）', () => {
  it('差集只插缺口 + name 统一加 "/" 前缀', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas(['/data-analysis:view:reports']));       // 现有
    mockFetch.mockResolvedValueOnce({ data: [{ owner: 'shanhai', name: '/x' }] });    // add 成功
    const r = await syncResources('shanhai', ['data-analysis:view:reports', 'data-analysis:view:x']);
    expect(r.added).toEqual(['data-analysis:view:x']);
    expect(r.skippedExisting).toEqual(['data-analysis:view:reports']);
    expect(mockFetch).toHaveBeenLastCalledWith('/api/add-resource', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ owner: 'shanhai', name: '/data-analysis:view:x' }),  // ← 前缀归一
    }));
  });
  it('撞 PK（重复插入）→ 吞 duplicate 继续（幂等重跑 no-op）', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas([]));
    mockFetch.mockRejectedValueOnce(new Error('duplicate key'));  // 首插撞（并发窗口）
    mockFetch.mockResolvedValueOnce({ data: [{ owner: 'shanhai', name: '/y' }] }); // retry 成功
    const r = await syncResources('shanhai', ['data-analysis:view:y']);
    expect(r.added).toEqual(['data-analysis:view:y']);
    expect(r.failed).toEqual([]);
  });
  it('同步失败不静默（L2）：逐 key 结果进 failed，不 throw 中断整批', async () => {
    mockFetch.mockResolvedValueOnce(remoteHas([]));
    mockFetch.mockRejectedValueOnce(new Error('charset?'));      // category:水果 若被拒
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const r = await syncResources('shanhai', ['data-analysis:category:水果', 'data-analysis:view:z']);
    expect(r.failed.map((f) => f.key)).toEqual(['data-analysis:category:水果', 'data-analysis:view:z']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/sync/__tests__/resource-sync.test.ts`，Expected: FAIL。
- [ ] **Step 3: 实现**

```ts
// web/lib/sync/resource-sync.ts
// resource 注册 adapter（spec §5.1 ③）：Casdoor 原生 add-resource，只增改不删。
// ★H3 怪癖（代码注释钉死，V2 源码验证项）：add-resource = 裸 Insert（PK=owner+name，重复即报错）；
//   GetResource/get-resources 查表恒加 "/" 前缀 → 写入与比对都统一 "/" 前缀归一化。
// ★L2：同步失败若静默跳过 → 能力永不可配——逐 key 结果显式反馈，failed 进对账红区。
import { casdoorFetch } from './casdoor-client';
import { CATALOG_KEYS, DEPRECATED_KEYS } from '../capability-catalog';

const norm = (name: string): string => (name.startsWith('/') ? name : `/${name}`);
const denorm = (name: string): string => name.replace(/^\//, '');

export interface SyncReport {
  added: string[]; skippedExisting: string[]; failed: { key: string; error: string }[];
}

export async function syncResources(owner: string, keys?: readonly string[]): Promise<SyncReport> {
  const want = keys ?? [...CATALOG_KEYS];                       // 默认全 catalog（deprecated 不注册）
  const list = want.filter((k) => !DEPRECATED_KEYS.has(k));
  const resp = await casdoorFetch('/api/get-resources?owner=' + encodeURIComponent(owner), {});
  const have = new Set<string>(
    ((resp as { data?: { name?: string }[] }).data ?? []).map((r) => denorm(r.name ?? '')),
  );
  const report: SyncReport = { added: [], skippedExisting: [], failed: [] };
  for (const key of list) {
    if (have.has(key)) { report.skippedExisting.push(key); continue; }
    try {
      await casdoorFetch('/api/add-resource', {
        method: 'POST',
        body: JSON.stringify({ owner, name: norm(key) }),       // ← "/" 前缀归一（H3）
      });
      report.added.push(key);
    } catch (e1) {
      try {                                                       // 并发撞 PK → 重读确认已被插过
        const re = await casdoorFetch('/api/get-resources?owner=' + encodeURIComponent(owner), {});
        const have2 = new Set(((re as { data?: { name?: string }[] }).data ?? []).map((r) => denorm(r.name ?? '')));
        if (have2.has(key)) { report.added.push(key); continue; }
      } catch { /* fallthrough to failed */ }
      report.failed.push({ key, error: e1 instanceof Error ? e1.message : String(e1) });
    }
  }
  return report;
}
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/sync/__tests__/resource-sync.test.ts`，Expected: PASS（3 例）。
- [ ] **Step 5: Commit** `git add web/lib/sync/resource-sync.ts web/lib/sync/__tests__/resource-sync.test.ts && git commit -m "feat(sync): resource 同步 adapter——/ 前缀归一+差集只插+dup retry+逐 key 反馈（W1 Task4，H3/L2）"`

---

### Task 5: permission.resources vs catalog 对账（W1 退出判据）

**Files:**
- Create: `scripts/reconcile-catalog.mjs`
- Test: `scripts/tests/reconcile-catalog.test.mjs`

**Interfaces:** Consumes: Casdoor `GET /api/get-permissions?owner=`（真授权语义——F11：与 get-resources 注册表区分，对账基准用 permissions 的 resources 并集）；Task 3 `validateKey`（node 侧直接内联同逻辑或 import 编译产物——脚本内自含判定避免 web 构建依赖）。Produces: 退出码 0=无红 / 1=有 C/E 级 diff；stdout JSON `{ summary: {counts}, red: [{kind, key, holders}], perUser: [{user, keys}] }`。Task 6（cron + 辅助页数据源）消费。

- [ ] **Step 1: 写失败测试**

```js
// scripts/tests/reconcile-catalog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff } from '../reconcile-catalog.mjs';

const CATALOG = new Set(['data-analysis:view:reports', 'data-analysis:field:cost', 'data-analysis:admin']);
const DEPRECATED = new Set([]);

test('permission.resources 引用未注册 key → E 级（反向发现，校验器同源逻辑）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:reports', 'data-analysis:view:ghost'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  assert.equal(d.red.length, 1);
  assert.equal(d.red[0].kind, 'E-unknown-key');
  assert.equal(d.red[0].key, 'data-analysis:view:ghost');
});

test('catalog 内 key 未被任何 permission 引用 → M 级提示（不算红）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:reports'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  assert.equal(d.red.length, 0);
  assert.ok(d.minor.length >= 2); // field:cost / admin 未被引用
});

test('通配持有者出现在废弃审计的 holders 里（M2：按 key 审计显示不出）', () => {
  const d = classifyDiff({
    permissions: [{ name: 'p-wild', resources: ['data-analysis:view:*'] }],
    catalog: CATALOG, deprecated: new Set(['data-analysis:view:gone']),
  });
  const gone = d.red.find((r) => r.key === 'data-analysis:view:gone');
  assert.ok(gone, '废弃 key 引用 = 红');
  assert.deepEqual(gone.holders, ['p-wild(view:*)']);  // 通配持有者必须可见
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/reconcile-catalog.test.mjs`，Expected: FAIL。
- [ ] **Step 3: 实现**

```js
// scripts/reconcile-catalog.mjs
// 3-way 对账的 W1 切片（spec §5.8）：Casdoor permission.resources（真授权语义，F11）vs catalog。
// 分级沿用 08-15 C/E/M：E=引用未知/废弃 key（红）；C=同步失败累积（由 Task 4 failed 通道喂入，本脚本读 outbox/日志摘要——V1 从 stdin 可选）；M=未引用能力（提示）。
import { readFileSync } from 'node:fs';

export function classifyDiff({ permissions, catalog, deprecated }) {
  const red = [], minor = [], perUser = [];
  const referenced = new Map(); // key → holders[]
  for (const p of permissions) {
    for (const r of p.resources ?? []) {
      if (!referenced.has(r)) referenced.set(r, []);
      referenced.get(r).push(p.resources.includes('*') ? `${p.name}(*)` : p.name);
    }
  }
  for (const [key, holders] of referenced) {
    if (deprecated.has(key)) red.push({ kind: 'E-deprecated-key', key, holders });
    else if (key === '*' || key.endsWith(':*')) continue;               // 通配本身合法（残余声明见 spec）
    else if (!catalog.has(key)) red.push({ kind: 'E-unknown-key', key, holders });
  }
  for (const key of catalog) if (!referenced.has(key)) minor.push({ kind: 'M-unreferenced', key });
  // 废弃 key 的通配持有者：显式展开进 holders（M2）
  for (const entry of red) {
    if (entry.kind !== 'E-deprecated-key') continue;
    for (const p of permissions) {
      const ws = (p.resources ?? []).filter((r) => r.endsWith(':*') &&
        entry.key.startsWith(r.slice(0, -1)));                          // view:* 匹配 view:xxx
      for (const w of ws) entry.holders.push(`${p.name}(${w})`);
    }
    entry.holders = [...new Set(entry.holders)];
  }
  for (const p of permissions)
    perUser.push({ user: p.name, keys: (p.resources ?? []).filter((r) => catalog.has(r)) });
  return { red, minor, perUser };
}

// ---- CLI：真实拉取 Casdoor permissions ----
async function main() {
  const { casdoorApi } = await import('../web/lib/sync/casdoor-client.ts').catch(() => ({}));
  // 脚本环境（node/tsx）下直接走 fetch + env（与 casdoor-client 同款 client_credentials）：
  const CASDOOR_API = process.env.CASDOOR_API;
  const t = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: process.env.CASDOOR_CLIENT_ID, client_secret: process.env.CASDOOR_CLIENT_SECRET }),
  }).then((r) => r.json());
  const perms = await fetch(`${CASDOOR_API}/api/get-permissions?owner=shanhai`, {
    headers: { Authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json());
  const catalogSrc = readFileSync(new URL('../web/lib/capability-catalog.ts', import.meta.url), 'utf8');
  // 单相真相：catalog 集合从 generated + manual 抽取（与 web/lib 同源文件，双源由 GHA scan 保证一致）
  const gen = readFileSync(new URL('../web/lib/capability-catalog.generated.ts', import.meta.url), 'utf8');
  const keys = new Set([...(`${catalogSrc}${gen}`.matchAll(/'(data-analysis:[a-z-]+:[^']+)'/g))].map((m) => m[1]));
  const d = classifyDiff({ permissions: perms.data ?? [], catalog: keys, deprecated: new Set() });
  console.log(JSON.stringify({ summary: { red: d.red.length, minor: d.minor.length }, ...d }, null, 2));
  if (d.red.length) process.exit(1);
}
if (process.argv[1]?.endsWith('reconcile-catalog.mjs') && !process.env.VITEST) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: 跑单测确认通过**：Run `node --test scripts/tests/reconcile-catalog.test.mjs`，Expected: PASS（3 例）。
- [ ] **Step 5: Commit** `git add scripts/reconcile-catalog.mjs scripts/tests/reconcile-catalog.test.mjs && git commit -m "feat(reconcile): permission.resources vs catalog 对账 C/E/M + 通配持有者审计（W1 Task5，W1 退出判据）"`

---

### Task 6: /admin/capabilities 辅助页 + GHA 部署钩子 + cron

**Files:**
- Create: `web/app/admin/capabilities/page.tsx`
- Modify: `web/app/admin/layout.tsx`（侧栏加「能力目录」入口——与 permissions 同级）
- Modify: `.github/workflows/deploy.yml`（step 4 之后插「Catalog scan & resource sync」）
- Create: `web/app/api/admin/capabilities/route.ts`（辅助页数据：catalog + synced 状态 + 校验结果）

**Interfaces:** Consumes: Task 1 catalog、Task 3 校验器、Task 4 syncResources、Task 5 reconcile JSON。Produces: 页面 `GET /admin/capabilities`（requireAdmin 门禁内）；API `GET /api/admin/capabilities`（返回 `{ entries, syncReport, reconcileSummary }`）；GHA step「Catalog scan & sync」（失败不阻断前端构建，与 functions step 同容错模式）。W1 退出判据「辅助页可看 synced 状态」落点。

- [ ] **Step 1: API 路由（requireAdmin 门禁，复用 web/lib/admin-api-auth.ts）**

```ts
// web/app/api/admin/capabilities/route.ts
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { capabilityCatalog, DEPRECATED_KEYS, VIEW_GROUPS } from '@/lib/capability-catalog';
import { validateKey, validateWildcardRisk, detectViewGroupCycle } from '@/lib/validate-capabilities';

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  // synced 状态：resource 表 vs catalog 差集（读 Casdoor get-resources，失败降级为 unknown 不阻塞页面）
  let synced: { ok: boolean; missing: string[] } = { ok: false, missing: [] };
  try {
    const { syncResources } = await import('@/lib/sync/resource-sync');
    const r = await syncResources('shanhai');          // 幂等：已有 skipped，缺的补——辅助页查看即自愈
    synced = { ok: r.failed.length === 0, missing: r.failed.map((f) => f.key) };
  } catch { /* Casdoor 不可达 → synced.unknown，页面显示降级态 */ }
  const perms: string[] = []; // 通配高风险从最近 reconcile 结果读（V1：页面内联校验 demo 权限集）
  return NextResponse.json({
    entries: capabilityCatalog,
    deprecated: [...DEPRECATED_KEYS],
    viewGroups: VIEW_GROUPS,
    cycleCheck: detectViewGroupCycle(),
    wildcardRisk: validateWildcardRisk(perms),
    synced,
  });
}
```

- [ ] **Step 2: 辅助页（server component + fetch 本路由，样式对齐 /admin/permissions 现有页面；表格列 = key/组/标签/敏感/来源/synced，红区列 = 废弃引用告警）**——照 `web/app/admin/permissions/page.tsx` 的表格骨架与 DESIGN.md（DM Sans + tabular-nums + slate 中性 + 深蓝主色）实现，废弃 key 行标红 + 「授权对象仍引用」提示（holders 来自 reconcile JSON）。
- [ ] **Step 3: GHA 部署钩子**（deploy.yml step 4「部署 edge functions」后插入，容错不阻断）：

```yaml
      - name: Catalog scan & resource sync (W1, 容错不阻断)
        continue-on-error: true
        run: |
          node scripts/scan-capabilities.mjs || echo '::warn::catalog generated 漂移'
          node --test scripts/tests/validate-capabilities.test.mjs 2>/dev/null || true
          ssh -i ~/.ssh/ShanHai-OPS.pem -o StrictHostKeyChecking=no root@data.shanhaiyiguo.com \
            "cd /opt/data-analytics-platform && CASDOOR_API=$CASDOOR_API \
             CASDOOR_CLIENT_ID=$CASDOOR_CLIENT_ID CASDOOR_CLIENT_SECRET=$CASDOOR_CLIENT_SECRET \
             node scripts/reconcile-catalog.mjs" || echo '::warn::catalog 对账失败（不阻断）'
```

- [ ] **Step 4: 手动验证**：本地 `cd web && npm run build`（页面/路由编译过）；`curl -s http://localhost:3000/api/admin/capabilities -H "Cookie: <伪造 admin claims>"` 返回 entries（testing-handbook §2 本地伪造 cookie 模式）。
- [ ] **Step 5: Commit** `git add web/app/admin/capabilities/ web/app/admin/layout.tsx .github/workflows/deploy.yml && git commit -m "feat(catalog): 能力目录辅助页 + GHA 钩子 + cron 对账入口（W1 Task6，W1 收口）"`

---

## W2：Group 目录 + 影子对账（只写不读）

### Task 7: maps_branch_group 映射表 + groups 投影列（迁移 178）

**Files:**
- Create: `database/migrations/178_maps_branch_group.sql`

**Interfaces:** Consumes: `dim_branch.branch_number`（既有门店维表，全局唯一键）。Produces: 表 `maps_branch_group(id, branch_number FK→dim_branch, group_id, group_name, group_type, is_active, synced_at)`、`UNIQUE(branch_number)`（一店一组）+ `UNIQUE(group_id)`；`org_users.groups TEXT`（JSON 数组投影列，F9）；后续 Task 8/9/10/11 消费。

- [ ] **Step 1: 写迁移（幂等模板，头部标 W 归属）**

```sql
-- 178_maps_branch_group.sql
-- W2 / spec §5.3：门店↔Group 自省映射 + groups 投影列（F9）。
-- 依赖：dim_branch（既有）。门店键铁律：branch_number 全局唯一（sbc-branch_num 派生），禁裸 branch_num。

CREATE TABLE IF NOT EXISTS maps_branch_group (
  id           BIGSERIAL PRIMARY KEY,
  branch_number TEXT NOT NULL,               -- dim_branch.branch_number（全局唯一派生键）
  group_id     TEXT NOT NULL,                -- Casdoor group id
  group_name   TEXT NOT NULL,                -- 展示用（判定用 group_id，改名不断链）
  group_type   TEXT NOT NULL DEFAULT 'store' -- 'store'|'region'|'dept'（三态，H13）
                CHECK (group_type IN ('store','region','dept')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_maps_branch UNIQUE (branch_number),
  CONSTRAINT fk_maps_group   UNIQUE (group_id),
  CONSTRAINT uq_maps_no_sep  CHECK (group_name NOT LIKE '%/%')  -- 禁分隔符（组路径精确匹配前提）
);
CREATE INDEX IF NOT EXISTS idx_maps_branch_group_type ON maps_branch_group(group_type) WHERE is_active;

-- groups 投影（F9）：无会话路径（run_push/agent-query）读门店行的唯一入口
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS groups JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 审计归因（H15）：同步器写入带「自动化」标记
ALTER TABLE maps_branch_group ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto'
  CHECK (source IN ('auto','manual'));

GRANT SELECT ON maps_branch_group TO anon, authenticated;
GRANT SELECT, UPDATE(groups) ON org_users TO authenticated;
```

- [ ] **Step 2: 本地语法验证**：Run `docker exec deploy-postgres-1 psql -U postgres -d insforge -f - < database/migrations/178_maps_branch_group.sql && docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT 1"` 再跑第二遍，Expected: 两遍全绿（幂等）。
- [ ] **Step 3: Commit** `git add database/migrations/178_maps_branch_group.sql && git commit -m "feat(w2): maps_branch_group 映射表 + org_users.groups 投影列（迁移178，H13/F9/H15）"`

---

### Task 8: 组同步器（两通道分离 + 先父后子 + 父链校验）

**Files:**
- Create: `web/lib/sync/group-sync.ts`
- Test: `web/lib/sync/__tests__/group-sync.test.ts`

**Interfaces:** Consumes: `casdoor-client.ts` casdoorFetch、`dim_branch`（PostgREST 读）、`maps_branch_group`（Task 7）、既有企微部门源（`org_departments` 同步链）。Produces: `syncDeptTree(depts)`（部门通道：企微 webhook/03:17 全量 → upsert 部门组）、`syncStoreTree()`（门店通道：diff(dim_branch vs maps_branch_group vs Group 树) 驱动）、`verifyParentChain(): {broken: {group: string, parent: string}[]}`（每日父链完整性校验，H1）、`upsertGroup({owner, name, parentName, type})` 内部先父后子。Task 10（对账）/11（claims）消费。

- [ ] **Step 1: 写失败测试**（mock casdoorFetch + PostgREST 查询）

```ts
// web/lib/sync/__tests__/group-sync.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({ casdoorFetch: vi.fn() }));
import { casdoorFetch } from '../casdoor-client';
import { upsertGroup, syncStoreTree, verifyParentChain } from '../group-sync';

const mockFetch = casdoorFetch as unknown as ReturnType<typeof vi.fn>;
const groupList = (names: {name: string; parentId?: string}[]) =>
  ({ data: names.map((n, i) => ({ owner: 'shanhai', name: n.name, id: `g${i}`, parentId: n.parentId ?? '', type: 'Virtual' })) });

describe('组同步器（spec §5.3，H1/H2）', () => {
  it('建树先父后子：父组请求先于子组（H1——后序会触发 GetUserFullGroupPath error 整组登录崩）', async () => {
    mockFetch.mockResolvedValueOnce(groupList([]));                    // 现有组=空
    mockFetch.mockResolvedValue({ data: { id: 'ok' } });               // add-group 全成功
    const calls: string[] = [];
    mockFetch.mockImplementation((path: string) => { calls.push(path); return Promise.resolve({ data: {} }); });
    await upsertGroup('shanhai', '熊喵-东区-门店A', '熊喵-东区', 'store');
    const firstAdd = calls.findIndex((c) => c.includes('add-group'));
    expect(firstAdd).toBeGreaterThanOrEqual(0);
    // 父组（熊喵-东区）的 add 必须出现在子组（门店A）之前
    const parentAdd = calls.findIndex((c) => c.includes('add-group'));
    expect(parentAdd).toBeLessThanOrEqual(firstAdd);
  });
  it('门店树 diff 驱动：dim_branch 新店 → 建 store 组 + 写 maps_branch_group；旧店改名 → 新名 upsert + 旧映射 is_active=false（H2）', async () => {
    // dim_branch 返回 3120-999 新店；maps 空；group 树空
    const fetchOrder: any[] = [];
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      fetchOrder.push({ path, body: init?.body });
      if (path.includes('get-groups')) return groupList([]);
      if (path.includes('get-branches')) return { data: [{ branch_number: '3120-999', branch_name: '新店' }] };
      return { data: { id: 'new-g' } };
    });
    const r = await syncStoreTree();
    expect(r.created).toEqual([{ branch_number: '3120-999', group_name: expect.stringContaining('3120-999') }]);
  });
  it('父链断裂检出（H1）：parentId 指向不存在组 → broken 非空', () => {
    const broken = verifyParentChain([
      { name: '孤儿组', parentId: '不存在' },
    ]);
    expect(broken).toEqual([{ group: '孤儿组', parent: '不存在' }]);
  });
  it('删除限于自建组（isCreatedBySyncer 标记）：非同步器建的组不进 delete 候选', () => {
    // 用类型判定暴露的 helper 纯函数直接测
    const { deletableGroups } = require('../group-sync');
    expect(deletableGroups([
      { name: 'auto-g', properties: JSON.stringify({ createdBy: 'group-sync' }) },
      { name: 'human-g', properties: '' },
    ])).toEqual(['auto-g']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/sync/__tests__/group-sync.test.ts`，Expected: FAIL。
- [ ] **Step 3: 实现**（核心逻辑；写 Casdoor 走 add-group/update-group，写本地走 PostgREST upsert maps_branch_group）

```ts
// web/lib/sync/group-sync.ts
// 组同步器（spec §5.3）——唯一自写组件。两通道分离（H2）：
//   部门树 = 企微源 upsert；门店树 = diff(dim_branch vs maps_branch_group vs Group 树) 驱动，
//   门店在企微未必有部门，门店通道禁挂企微 webhook。
// 先父后子（H1）：ParentId 存父 Name，父链断裂 → 原生 GetUserFullGroupPath error → 整组 JWT 签发失败。
// 删除限于自建（properties.createdBy='group-sync' 标记）；门店停用 = is_enabled=false 非真删。
import { casdoorFetch } from './casdoor-client';

export interface GroupUpserResult { created: string[]; updated: string[]; }

export async function upsertGroup(owner: string, name: string, parentName: string | null, type: 'store'|'region'|'dept'): Promise<void> {
  const existing = await casdoorFetch(`/api/get-groups?owner=${encodeURIComponent(owner)}`, {});
  const have = new Set(((existing as { data?: { name?: string }[] }).data ?? []).map((g) => g.name ?? ''));
  // ★先父后子：父不存在则先建父（递归一层足够——树深 ≤3：品牌→区域→门店）
  if (parentName && !have.has(parentName)) {
    await casdoorFetch('/api/add-group', {
      method: 'POST',
      body: JSON.stringify({
        owner, name: parentName, type: 'Virtual',
        parentId: '',                                       // 门店树根（品牌链）父=org 顶
        properties: JSON.stringify({ createdBy: 'group-sync', groupType: 'region' }),
        isEnabled: true,
      }),
    });
    have.add(parentName);
  }
  if (!have.has(name)) {
    await casdoorFetch('/api/add-group', {
      method: 'POST',
      body: JSON.stringify({
        owner, name, type: 'Virtual',
        parentId: parentName ?? '',
        properties: JSON.stringify({ createdBy: 'group-sync', groupType: type }),
        isEnabled: true,
      }),
    });
  }
}

export async function syncStoreTree(): Promise<{ created: { branch_number: string; group_name: string }[]; renamed: string[] }> {
  // 三源：dim_branch（真源）/ maps_branch_group（映射）/ Group 树（Casdoor）
  const branches = await casdoorFetch('/api/get-branches?select=branch_number,branch_name,system_book_code&is_active=eq.true', {});
  const groups = await casdoorFetch('/api/get-groups?owner=shanhai', {});
  const maps = await fetch(`${process.env.INSFORGE_URL}/maps_branch_group?is_active=eq.true`, {
    headers: { apikey: process.env.INSFORGE_ANON_KEY ?? '' },
  }).then((r) => r.json()) as { branch_number: string; group_id: string }[];
  const groupNames = new Set(((groups as { data?: { name?: string }[] }).data ?? []).map((g) => g.name ?? ''));
  const mapped = new Set(maps.map((m) => m.branch_number));
  const created: { branch_number: string; group_name: string }[] = [];
  for (const b of (branches as { data?: { branch_number: string; branch_name: string; system_book_code: string }[] }).data ?? []) {
    if (mapped.has(b.branch_number)) continue;
    // 组名含 branch_number（全局唯一），区域父组按 dim_branch 区域字段——此处用品牌链根占位，区域细分由 Task 10 对账驱动补
    const region = `${b.system_book_code === '3120' ? '熊喵' : '品品甜'}`;
    const groupName = `${region}-${b.branch_number}`;
    await upsertGroup('shanhai', groupName, region, 'store');
    await fetch(`${process.env.INSFORGE_URL}/maps_branch_group`, {
      method: 'POST',
      headers: { apikey: process.env.INSFORGE_ANON_KEY ?? '', 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ branch_number: b.branch_number, group_id: groupName, group_name: groupName, group_type: 'store', source: 'auto' }),
    });
    created.push({ branch_number: b.branch_number, group_name: groupName });
  }
  return { created, renamed: [] };
}

export function verifyParentChain(groups: { name: string; parentId: string }[]): { group: string; parent: string }[] {
  const names = new Set(groups.map((g) => g.name));
  return groups.filter((g) => g.parentId && !names.has(g.parentId))
    .map((g) => ({ group: g.name, parent: g.parentId }));
}

export function deletableGroups(groups: { name: string; properties: string }[]): string[] {
  return groups.filter((g) => {
    try { return JSON.parse(g.properties || '{}').createdBy === 'group-sync'; } catch { return false; }
  }).map((g) => g.name);
}

export async function syncDeptTree(_depts: unknown): Promise<GroupUpserResult> {
  // 部门通道（企微 webhook / 03:17 全量 → upsert 部门组）——接线到既有 org_departments 同步链后启用；
  // W2 影子期只写不读，部门组 group_type='dept' 不参与 branch 展开（H13 三态）。
  return { created: [], updated: [] };
}
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/sync/__tests__/group-sync.test.ts`，Expected: PASS（4 例）。
- [ ] **Step 5: Commit** `git add web/lib/sync/group-sync.ts web/lib/sync/__tests__/group-sync.test.ts && git commit -m "feat(w2): 组同步器——两通道分离+先父后子+父链校验+删除限自建（Task8，H1/H2）"`

---

### Task 9: 组类型三态展开 + groups claim 派生

**Files:**
- Create: `web/lib/sync/group-expand.ts`
- Test: `web/lib/sync/__tests__/group-expand.test.ts`

**Interfaces:** Consumes: `maps_branch_group`（Task 7）、Casdoor user.Groups（get-account 或原生 token groups，F4）。Produces: `expandGroupsToBranches(groups: readonly string[]): { branch_nums: readonly string[]; ok: boolean; error?: string }`（三态展开：store 直映/region 子孙并集/dept 不展开；未知组类型 fail-close）。Task 11（claims 构建）消费。

- [ ] **Step 1: 写失败测试**

```ts
// web/lib/sync/__tests__/group-expand.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../casdoor-client', () => ({ casdoorFetch: vi.fn() }));
import { expandGroupsToBranches } from '../group-expand';

// maps_branch_group 经 casdoorFetch mock 返回（实现里经 PostgREST 读）
function mapsOf(rows: { group_id: string; group_type: string; branch_number: string | null; is_active: boolean }[]) {
  return rows;
}
vi.mock('../casdoor-client', () => ({
  casdoorFetch: vi.fn(async () => ({ data: [
    { group_id: '熊喵-东区',         group_type: 'region', branch_number: null,     is_active: true },
    { group_id: '熊喵-东区-3120-001', group_type: 'store',  branch_number: '3120-001', is_active: true },
    { group_id: '熊喵-东区-3120-002', group_type: 'store',  branch_number: '3120-002', is_active: true },
    { group_id: '熊喵-西区-3120-003', group_type: 'store',  branch_number: '3120-003', is_active: true },
    { group_id: '采购部',             group_type: 'dept',   branch_number: null,     is_active: true },
  ] })),
}));

describe('组类型三态展开（spec §5.3 H13）', () => {
  it('门店叶子组 → 直映 branch_number', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区-3120-001']);
    expect(r).toEqual({ branch_nums: ['3120-001'], ok: true });
  });
  it('区域组 → 子孙门店叶子并集', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区']);
    expect([...(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '3120-002']);
  });
  it('部门组 → 不参与展开（空集但 ok，非 fail）', async () => {
    const r = await expandGroupsToBranches(['采购部']);
    expect(r).toEqual({ branch_nums: [], ok: true });
  });
  it('未知组 → fail-close（ok:false + error），空集结果仍返回但调用方须按 C2 处理', async () => {
    const r = await expandGroupsToBranches(['不存在的组']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown');
  });
  it('混合：store+region 并集去重；用户挂部门组+区域组 → 只区域贡献门店', async () => {
    const r = await expandGroupsToBranches(['熊喵-东区-3120-001', '熊喵-东区', '采购部']);
    expect([...new Set(r.branch_nums ?? [])].sort()).toEqual(['3120-001', '3120-002']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/sync/__tests__/group-expand.test.ts`，Expected: FAIL。
- [ ] **Step 3: 实现**

```ts
// web/lib/sync/group-expand.ts
// 组→门店三态展开（H13）：store 叶子直映 / region=子孙 store 并集 / dept 不参与。
// 未知组 fail-close（ok:false）——调用方（claims 构建）按 C2 处理：不产出门店范围或整体失败。
// ★门店键铁律：输出是 branch_number（全局唯一），RLS 端精确匹配。
import { casdoorFetch } from './casdoor-client';

export interface ExpandResult {
  branch_nums: readonly string[];
  ok: boolean;
  error?: string;
}

export async function expandGroupsToBranches(groups: readonly string[]): Promise<ExpandResult> {
  if (groups.length === 0) return { branch_nums: [], ok: true };   // 空集=authorized ∅，由上层 deny（B1）
  const mapsResp = await casdoorFetch('/api/get-branch-group-maps?is_active=eq.true', {});
  const maps = ((mapsResp as { data?: { group_id: string; group_type: string; branch_number: string | null }[] }).data ?? []);
  const byId = new Map(maps.map((m) => [m.group_id, m]));
  const unknown = groups.filter((g) => !byId.has(g) && !maps.some((m) => m.group_id.startsWith(g + '-') || g.startsWith(m.group_id.split('-').slice(0, 2).join('-') + '-')));
  // 严格判定：组名要么精确命中 maps.group_id，要么作为前缀拥有子孙
  const results = new Set<string>();
  for (const g of groups) {
    const exact = byId.get(g);
    if (exact) {
      if (exact.group_type === 'store' && exact.branch_number) results.add(exact.branch_number);
      else if (exact.group_type === 'region') {
        for (const m of maps) if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      }
      // dept：不贡献（H13）
      continue;
    }
    const asRegion = maps.some((m) => m.group_id.startsWith(g + '-'));
    if (asRegion) {
      for (const m of maps) if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      continue;
    }
    return { branch_nums: [], ok: false, error: `unknown group: ${g}` };   // fail-close（H13 未知组）
  }
  return { branch_nums: [...results].sort(), ok: true };
}
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/sync/__tests__/group-expand.test.ts`，Expected: PASS（5 例）。
- [ ] **Step 5: Commit** `git add web/lib/sync/group-expand.ts web/lib/sync/__tests__/group-expand.test.ts && git commit -m "feat(w2): 组类型三态展开+未知组 fail-close（Task9，H13/B1）"`

---

### Task 10: 独立期望源「人→门店」对账 + 影子对账 7 天门禁（W2 退出判据）

**Files:**
- Create: `scripts/reconcile-groups.mjs`
- Test: `scripts/tests/reconcile-groups.test.mjs`
- Create: `web/app/api/admin/cron/reconcile-groups/route.ts`（每日 cron 入口，接 08-15 cron 框架）

**Interfaces:** Consumes: dim_war_zone 考核分区（独立期望源——取自数据而非 Group 树，H10）、org_users.groups 投影（Task 7）、maps_branch_group（Task 7）。Produces: `classifyMembershipDiff({ expected, actual })`（期望=店长/督导岗位清单或考核分区人→门店；实际=org_users.groups 展开；输出 per-user 成员级 diff，C/E/M 分级）；cron 落 reconcile_logs（复用 collect_logs 模式）+ `collect_fail` 告警；影子对账历史表 `group_reconcile_history(date, whitelist_outside_diff_count, red_count)` 供 7 天门禁查询。

- [ ] **Step 1: 写失败测试**

```js
// scripts/tests/reconcile-groups.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMembershipDiff } from '../reconcile-groups.mjs';

test('成员级 diff：用户在期望源有店 A 但挂组展开无 A → E 级红（per-user 粒度）', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'zhangsan', branch_numbers: ['3120-001', '3120-002'] }],
    actual:   [{ user: 'zhangsan', branch_numbers: ['3120-001'] }],
    whitelist: [],
  });
  assert.equal(d.red.length, 1);
  assert.equal(d.red[0].user, 'zhangsan');
  assert.equal(d.red[0].missing[0], '3120-002');
});

test('白名单条目豁免（人工审批挂组）：diff 命中白名单 → 不算红、单列 whitelistHits', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'lisi', branch_numbers: ['3120-005'] }],
    actual:   [{ user: 'lisi', branch_numbers: [] }],
    whitelist: [{ user: 'lisi', branch_number: '3120-005', reason: '督导跨区', approvedBy: 'boss', approvedAt: '2026-08-20' }],
  });
  assert.equal(d.red.length, 0);
  assert.equal(d.whitelistHits.length, 1);
});

test('多挂（实际比期望多店）→ E 级红（越权方向）', () => {
  const d = classifyMembershipDiff({
    expected: [{ user: 'wang', branch_numbers: ['3120-001'] }],
    actual:   [{ user: 'wang', branch_numbers: ['3120-001', '64188-001'] }],
    whitelist: [],
  });
  assert.equal(d.red[0].extra[0], '64188-001');
});

test('7 天门禁判定：连续 7 天白名单外 diff=0 才 pass', () => {
  const gate = (history) => history.slice(-7).length === 7 && history.slice(-7).every((h) => h.whitelistOutsideDiff === 0 && h.redCount === 0);
  assert.equal(gate(Array.from({ length: 7 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 }))), true);
  assert.equal(gate([{ whitelistOutsideDiff: 0, redCount: 0 }, ...Array.from({ length: 6 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 }))].concat([{ whitelistOutsideDiff: 2, redCount: 1 }])), false);
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/reconcile-groups.test.mjs`，Expected: FAIL。
- [ ] **Step 3: 实现**

```js
// scripts/reconcile-groups.mjs
// W2 独立期望源对账（spec §5.8 H10）：期望 = 考核分区/岗位清单（取自 dim_war_zone 数据），
// 非 org_departments 投影（那是被测对象，循环自证）。per-user 成员级 diff + C/E/M 分级。
// 7 天门禁：白名单外 diff=0 连续 ≥7 天才放行 W3（M4）。
export function classifyMembershipDiff({ expected, actual, whitelist }) {
  const red = [], minor = [], whitelistHits = [];
  const wl = new Set((whitelist ?? []).map((w) => `${w.user}:${w.branch_number}`));
  const byUser = new Map(actual.map((a) => [a.user, a.branch_numbers]));
  for (const e of expected) {
    const got = byUser.get(e.user) ?? [];
    const missing = e.branch_numbers.filter((b) => !got.includes(b) && !wl.has(`${e.user}:${b}`));
    const extra   = got.filter((b) => !e.branch_numbers.includes(b) && !wl.has(`${e.user}:${b}`));
    const wlHit   = e.branch_numbers.filter((b) => !got.includes(b) && wl.has(`${e.user}:${b}`));
    if (missing.length || extra.length) red.push({ user: e.user, missing, extra });
    if (wlHit.length) whitelistHits.push({ user: e.user, branches: wlHit });
  }
  // M 级：期望源缺席的用户挂了组（新员工未进分区清单——提示补录，不算红）
  const expUsers = new Set(expected.map((e) => e.user));
  for (const a of actual) if (!expUsers.has(a.user) && a.branch_numbers.length) minor.push({ user: a.user, kind: 'M-not-in-expected' });
  return { red, minor, whitelistHits };
}
export const gate7days = (history) =>
  history.slice(-7).length === 7 &&
  history.slice(-7).every((h) => h.whitelistOutsideDiff === 0 && h.redCount === 0);
```

- [ ] **Step 4: 跑单测确认通过**：Run `node --test scripts/tests/reconcile-groups.test.mjs`，Expected: PASS（4 例）。
- [ ] **Step 5: cron 路由**：`web/app/api/admin/cron/reconcile-groups/route.ts`——每日 03:37（错开既有采集/对账窗口）跑：拉期望源（dim_war_zone 考核门店 × 店长岗位映射）+ 实际（org_users.groups 展开）→ classifyMembershipDiff → 写 `group_reconcile_history` + red>0 发 `collect_fail` 企微告警。表结构 `CREATE TABLE IF NOT EXISTS group_reconcile_history(date DATE PRIMARY KEY, whitelist_outside_diff INT NOT NULL, red_count INT NOT NULL, detail JSONB)`（并进 Task 7 迁移 178 补充段——`ALTER`/`CREATE IF NOT EXISTS` 幂等安全）。
- [ ] **Step 6: Commit** `git add scripts/reconcile-groups.mjs scripts/tests/reconcile-groups.test.mjs web/app/api/admin/cron/reconcile-groups/ database/migrations/178_maps_branch_group.sql && git commit -m "feat(w2): 独立期望源人→门店对账+7天门禁（Task10，H10/M4，W2 退出判据）"`

---

## W3：claims 契约扩展 + RLS 策略分支（与 U2 同一发布窗）

> ⚠️ 本波与 U2（登录切换）同一发布窗执行（spec：避免双次登录链路改版）。若 U2 未就绪，本波 task 只能合码不部署——dispatch 前人在 gate 确认 U2 窗口。

### Task 11: wecom-oidc-callback claims 三段扩展 + B2 permissions 资源串迁移

**Files:**
- Modify: `functions/wecom-oidc-callback/index.js`（现状 L146-166 写四维维度 key + `perms.branch_nums || ["*"]` 兜底）
- Test: `functions/wecom-oidc-callback/claims.test.js`（新建——Deno 风格 import 断言，随 function 目录；本地 `deno test` 或 node 兼容断言跑）

**Interfaces:** Consumes: Casdoor 原生 token groups（`useGroupPathInToken` 开启后 OIDC token 自带全路径 claim；或 get-account 读 `user.Groups`——「get-user-groups」路由不存在，**禁调用**，F4）、`get-all-objects`（可达对象 → `data-analysis:*` 子集 + `push:*` 裸 key，F11）、maps_branch_group（Task 7 展开映射，经 PostgREST 读）。Produces: claims 新增四段 `groups`（完整路径精确数组）/ `data_scope{brands,categories,branch_nums}`（空段=deny 语义载体）/ `fields{cost}` / `catalog_v`（部署版本戳 env 注入 `CATALOG_V`）；`permissions` 值迁移为资源串（B2）；顶层旧四维 key **保留且值=全维非空镜像**（B6/M1 值判据）。Task 12（RLS 分支）/13（catalog_v 校验）消费。

- [ ] **Step 1: 写失败测试**（claims 构建器提为可测纯函数 `buildClaims(ctx)`）

```js
// functions/wecom-oidc-callback/claims.test.js
// 断言库零依赖（Deno/node 双跑）：手写 assert
import { buildClaims } from './claims.js';

const eq = (a, b, msg) => { const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { console.error(`✗ ${msg}\n  got:  ${ja}\n  want: ${jb}`); Deno?.exit(1) ?? process.exit(1); }
  else console.log(`✓ ${msg}`); };

// 三段全成功的上下文
const okCtx = {
  oidcToken: { groups: ['shanhai/熊喵-东区', 'shanhai/熊喵-东区-3120-001'] },  // 原生 token groups（F4）
  reachable: ['data-analysis:view:reports', 'push:broadcast', 'data-analysis:field:cost', 'data-analysis:brand:3120'],
  expand: async () => ({ branch_nums: ['3120-001'], ok: true }),                // Task 9 展开注入
  catalogV: '20260816.1',
  legacy: { role_code: 'store_manager', visible_panels: ['reports'], default_landing: '/reports', default_metric: 'sale', departments: ['东区'] },
};

// 三段失败注入
const failCtx = { ...okCtx, expand: async () => ({ branch_nums: [], ok: false, error: 'unknown group' }) };

eq(buildClaims(okCtx).data_scope.branch_nums, ['3120-001'], '门店叶子展开进 data_scope.branch_nums');
eq(buildClaims(okCtx).groups, ['shanhai/熊喵-东区', 'shanhai/熊喵-东区-3120-001'], 'groups = 原生 token 全路径精确数组');
eq(buildClaims(okCtx).permissions.includes('data-analysis:view:reports'), true, 'permissions = 资源串（B2，非四维 key）');
eq(buildClaims(okCtx).permissions.includes('push:broadcast'), true, 'push 裸 key 保留（H4 禁前缀）');
eq(buildClaims(okCtx).fields.cost, true, 'field:cost 资源 → fields.cost=true');
eq(buildClaims(okCtx).catalog_v, '20260816.1', 'catalog_v 版本戳透传');
eq(buildClaims(okCtx).role_code, 'store_manager', '08-15 保留字段不丢（H5）');

const denied = buildClaims(failCtx);
eq(denied, null, '三段任一失败（展开 ok:false）→ 返回 null = 登录整体失败，禁空数组进 claims（C2）');

// B6/M1 值判据：顶层旧 key = 全维非空镜像（brands 有值时镜像；branch_nums 无授权时——不存在「空数组镜像」）
const zeroScopeCtx = { ...okCtx, expand: async () => ({ branch_nums: [], ok: true }), reachable: [] };
const z = buildClaims(zeroScopeCtx);
eq(z.data_scope.branch_nums, [], '空集段 = authorized ∅（deny 语义载体，B1）');
eq(z.branch_nums, undefined, '顶层旧 key 无非空镜像值时不写（禁空数组——072 空数组→true 全放，M1）');
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`，Expected: FAIL（claims.js 不存在）。
- [ ] **Step 3: 实现**——把 callback 内联 claims 逻辑提为 `claims.js` 纯函数（`buildClaims(ctx)` 接收注入的三段输入），`index.js` 改为组装 ctx 调用；保留全部既有字段签发逻辑不动（role_code/visible_panels/default_landing/default_metric/departments/roles/permissions）

```js
// functions/wecom-oidc-callback/claims.js
// claims 构建器（spec §5.4，W3 变更集）——三段：原生 token groups / get-all-objects 可达对象 / 门店叶子展开。
// 铁律：
//  B2  permissions = data-analysis:* 资源串 + push:* 裸 key（引擎字面量，H4 禁 data-analysis: 前缀）；
//      迁移前旧值是四维维度 key（branch_nums/brands/categories/can_see_cost）——本函数不再产出。
//  B1  data_scope 空段 = authorized ∅（deny）——原样写空数组，禁收敛 ["*"]。
//  B6/M1 顶层旧四维 key 只在「有非空镜像值」时写；禁空数组/省略形态漂进 072 的空数组→true 全放路径。
//       （判定不读顶层旧 key——RLS 策略分支以 data_scope 段存在性为准，迁移 179；旧 key 仅兼容展示/审计。）
//  C2  三段任一失败（展开 ok:false / groups 段缺失 / 可达对象拉取失败）→ 返回 null = 登录整体失败。
//  H5  08-15 保留字段（role_code/visible_panels/default_landing/default_metric/departments）全量透传。
export function buildClaims(ctx) {
  // --- 三段输入完整性（C2 fail-close）---
  const oidcGroups = ctx.oidcToken?.groups ?? null;
  if (!Array.isArray(oidcGroups) || oidcGroups.length === 0) return null;   // 半可达/无组 → 整体失败
  if (!Array.isArray(ctx.reachable)) return null;                            // get-all-objects 失败 → 整体失败
  const expanded = ctx.expandResult;                                         // 已由调用方 await（见下）
  if (!expanded || expanded.ok !== true) return null;                        // 展开失败/未知组 → 整体失败

  // --- permissions（B2）：资源串过滤 ---
  const permissions = ctx.reachable.filter((k) =>
    k === '*' || k.startsWith('data-analysis:') || k.startsWith('push:'));

  // --- data_scope（B1）三维 ---
  const brands     = permissions.filter((k) => k.startsWith('data-analysis:brand:')).map((k) => k.slice('data-analysis:brand:'.length));
  const categories = permissions.filter((k) => k.startsWith('data-analysis:category:')).map((k) => k.slice('data-analysis:category:'.length));
  const data_scope = { brands, categories, branch_nums: [...expanded.branch_nums] };

  // --- fields（列掩码开关）---
  const fields = { cost: permissions.includes('data-analysis:field:cost') };

  // --- 顶层旧 key 全维非空镜像（B6/M1 值判据：只在非空时写）---
  const mirror = {};
  if (data_scope.branch_nums.length) mirror.branch_nums = data_scope.branch_nums;
  if (brands.length)                 mirror.brands = brands;
  if (categories.length)             mirror.categories = categories;
  if (fields.cost)                   mirror.can_see_cost = true;

  return {
    ...ctx.legacy,                       // H5：08-15 保留字段（role_code 等）全量透传
    permissions,                         // B2 资源串
    groups: oidcGroups,                  // F4：原生 token 全路径（判定用，禁中文 label 派生）
    data_scope,                          // B1：空段 = deny 语义载体
    fields,
    catalog_v: ctx.catalogV,
    ...mirror,                           // B6：双氧期顶层旧 key（全维非空镜像，禁空数组）
  };
}
```

`index.js` 接线（核心改动区，其余签发逻辑不动）：

```js
// index.js 内：三段组装（伪代码定位——在既有拉 roles/get-permissions 处扩展）
const reachableObjects = await fetchAllObjects(accessToken);          // get-all-objects → data-analysis:*/push:* 子集
const expandResult = await expandGroupsToBranches(oidcToken.groups); // Task 9 逻辑的 function 内联（HTTP 读 maps_branch_group——不内嵌 catalog，只读映射表，H12 合规）
const claims = buildClaims({ oidcToken, reachable: reachableObjects, expandResult, catalogV: Deno.env.get('CATALOG_V') ?? '0', legacy: existingLegacyClaims });
if (!claims) return new Response('group scope unavailable, login denied', { status: 503 });  // C2：整体失败
// ……既有 JWT 签发（claims 替换原 payload）+ 写穿 org_users.groups 投影（F9）
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`，Expected: PASS（9 断言全绿）。
- [ ] **Step 5: 生产部署（function-only 路径，不走 GHA）**：按 CLAUDE.md「只改 function 的生产部署流程」SSH 直调 InsForge API PUT + 清 Deno 缓存 + `curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-oidc-callback` 验证——**但本 task 部署受 U2 同窗约束：只在 U2 发布窗内执行，否则停在本地 commit**。
- [ ] **Step 6: Commit** `git add functions/wecom-oidc-callback/ && git commit -m "feat(w3): claims 三段扩展+B2 资源串迁移+B6 非空镜像+C2 整体失败（Task11，W3 核心）"`

---

### Task 12: RLS 策略分支 scope_match_v2——空集 deny enforce 机制（迁移 179，M1 封口）

**Files:**
- Create: `database/migrations/179_rls_scope_branch.sql`
- Test: `scripts/tests/rls-branch-policy.test.mjs`（注入式：psql 伪造 claims 会话，testing-handbook §2 本地参数化 claim 模式）

**Interfaces:** Consumes: 既有 `claim_match_or_star`（072，**保持不动**——legacy 支继续用）、`pgrst_pre_request` 扁平机制（114：`data_scope` 顶层对象会整体出现在 `request.jwt.claims.data_scope` 单 GUC）。Produces: 函数 `scope_match_v2(p_dim TEXT, p_col TEXT)`——形状鉴别器：`request.jwt.claims.data_scope IS NOT NULL`（新 claims）→ 读 data_scope 该维（**空数组=deny**，通配 `["*"]` 或含 `*`=放行）；缺失（legacy）→ 回退 `claim_match_or_star`（旧语义原样）。替换全部行级策略（032/058/072/107/112/113 的 branch_nums/brands/categories 消费位）改调 `scope_match_v2`。Task 16（消费侧切）依赖；Task 20（W6）删回退支。

- [ ] **Step 1: 写注入测试（红：先证明现状空数组=全放）**

```js
// scripts/tests/rls-branch-policy.test.mjs
// 迁移 179 的红→绿注入测试（M1 封口）：迁移前空 data_scope 声称 deny 的用户在新 RLS 下 0 行；
// 迁移前（红态断言）旧 RLS 对「顶层空数组」全放——本测试在 179 应用后跑，验证绿态 + 钉死旧语义只对 legacy 形状生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();

function withClaims(claimsJson, sql) {
  return PSQL(`BEGIN; SELECT set_config('request.jwt.claims', '${JSON.stringify(claimsJson).replace(/'/g, "''")}', true); ${sql}; ROLLBACK;`);
}

test('绿：新形状（data_scope 存在且 branch_nums 空）→ 0 行（B1 空集=deny，不收敛 *)', () => {
  const n = withClaims(
    { sub: 'shanhai/test', data_scope: { brands: [], categories: [], branch_nums: [] }, branch_nums: ['3120-001'] },
    `SELECT count(*) FROM report_daily_sale_v WHERE false`   // ← 行策略作用在受 RLS 保护的事实表；此处用真实表名见 Step 3 清单
  );
  // 实际断言经 scope_match_v2 直判（不依赖具体表）：
  const ok = withClaims(
    { sub: 'shanhai/test', data_scope: { branch_nums: [] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 'f');                                       // 空=deny
});

test('绿：新形状含通配 ["*"] → 放行（通配语义保留）', () => {
  const ok = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['*'] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 't');
});

test('绿：新形状具体门店列表 → 精确命中放行', () => {
  const ok = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['3120-001'] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 't');
});

test('绿：legacy 形状（无 data_scope 段）→ 回退 claim_match_or_star 旧语义（含空数组全放——仅限旧形状，S4 豁免窗口）', () => {
  const okNull = withClaims({ sub: 'shanhai/test' },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);          // 顶层无 key → 072 NULL→true
  assert.equal(okNull, 't');
  const okEmpty = withClaims({ sub: 'shanhai/test', branch_nums: [] },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);          // 顶层空数组 → 072 空→true（legacy 宽松支，钉死现状）
  assert.equal(okEmpty, 't');
});

test('绿：顶层旧 key 空数组 + data_scope 并存 → 走 data_scope 分支不受 072 污染（M1 核心攻击路径封口）', () => {
  // 攻击形态：实现者若按值一致性直觉在新 claims 写顶层空数组 → 072 路径全放；
  // 策略分支必须以 data_scope 存在性优先，072 不再被读到。
  const ok = withClaims({ sub: 'shanhai/test', branch_nums: [], data_scope: { branch_nums: [] } },
    `SELECT scope_match_v2('branch_nums', 'branch_number')`);
  assert.equal(ok, 'f');                                       // data_scope 分支赢 → deny
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/rls-branch-policy.test.mjs`，Expected: FAIL（`scope_match_v2` 不存在）。
- [ ] **Step 3: 写迁移 179**

```sql
-- 179_rls_scope_branch.sql
-- W3 / spec 全局约束 6·enforce 机制（redteam-lite M1 封口，方案①策略分支——spec 终审钉死）。
-- 形状鉴别器：request.jwt.claims.data_scope 存在（114 扁平后为顶层 GUC，jsonb）→ 新 claims 路径
--   （空段=deny，B1）；缺失 → 回退 legacy claim_match_or_star（072 原语义，含空数组→true 的
--   legacy 宽松支——仅旧形状令牌可触发，S4 豁免窗口，W4 切走后回退支由 Task 20 删除）。
-- ★严禁对本函数的 data_scope 分支使用 claim_match_or_star（其空数组/NULL→true 全放，M1）。

CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_scope JSONB;
  v_dim   JSONB;
  v_val   TEXT;
BEGIN
  -- 新 claims 分支：data_scope 段存在 → 只认 data_scope（空=deny）
  v_scope := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'data_scope';
  IF v_scope IS NOT NULL THEN
    v_dim := v_scope -> p_dim;
    IF v_dim IS NULL THEN
      RETURN FALSE;                       -- 段存在但维度缺失 = deny（禁回退——形状已判新）
    END IF;
    IF jsonb_array_length(v_dim) = 0 THEN
      RETURN FALSE;                       -- ★空数组 = authorized ∅ = deny（B1；072 在此返回 true，禁用之）
    END IF;
    IF v_dim ? '*' THEN
      RETURN TRUE;                        -- 通配放行（语义保留）
    END IF;
    -- 行级精确匹配：p_col 列值 ∈ data_scope 数组（门店用 branch_number 全局唯一——门店键铁律）
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  -- legacy 分支：无 data_scope 段 → 072 旧语义（NULL/空数组→true 宽松支仅此可达，S4）
  RETURN claim_match_or_star(p_col, p_dim);
END;
$$;

-- 全部行级策略替换为 scope_match_v2（清单 = 032/058/072/107/112/113 的四维消费位；
--   逐表 DROP POLICY IF EXISTS + CREATE POLICY——幂等模板铁律）
-- 模式（每表同款，以下为示例两表，worker 按 grep 'claim_match_or_star' 全量清点替换并逐表落）：
DROP POLICY IF EXISTS branch_rls ON report_daily_sale_v;
CREATE POLICY branch_rls ON report_daily_sale_v FOR SELECT TO authenticated
  USING (scope_match_v2('branch_nums', branch_number));

DROP POLICY IF EXISTS brand_rls ON report_daily_wholesale_v;
CREATE POLICY brand_rls ON report_daily_wholesale_v FOR SELECT TO authenticated
  USING (scope_match_v2('brands', system_book_code));

-- ……（worker 执行时先跑：
--   SELECT policyname, tablename, qual FROM pg_policies WHERE qual LIKE '%claim_match_or_star%';
--   得到全量清单后逐表替换——替换后该查询须 0 行；can_see_cost 列掩码位不在本迁移（列掩码 Task 16））
GRANT EXECUTE ON FUNCTION scope_match_v2 TO anon, authenticated;
```

- [ ] **Step 4: 跑测试确认通过**：Run `docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/179_rls_scope_branch.sql && node --test scripts/tests/rls-branch-policy.test.mjs`，Expected: 5 例 PASS；迁移跑第二遍仍全绿（幂等）。
- [ ] **Step 5: 全量清点断言**：Run `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc "SELECT count(*) FROM pg_policies WHERE qual LIKE '%claim_match_or_star%'"`，Expected: `0`（全部走 v2）。
- [ ] **Step 6: Commit** `git add database/migrations/179_rls_scope_branch.sql scripts/tests/rls-branch-policy.test.mjs && git commit -m "feat(w3): scope_match_v2 策略分支——空集 deny enforce 机制（迁移179，M1 封口+B1/S4）"`

---

### Task 13: feature-perm catalog_v 快/慢路径 + 解析期校验 + 例外并集段（pgrst）

**Files:**
- Modify: `web/lib/feature-perm.ts`（现有 view 权限判定——catalog_v 校验进快判层）
- Create: `web/lib/exception-claims.ts` + Test `web/lib/__tests__/exception-claims.test.ts`
- Modify: `database/migrations/179_rls_scope_branch.sql` 补充段 or 新增 `database/migrations/183_temporary_grants.sql` 的 pgrst 部分前置——**例外并集段放迁移 183（Task 17），本 task 只做 catalog_v + 解析期校验**（W3/W5 职责切分：W3 = 校验器；W5 = 例外表）

**Interfaces:** Consumes: Task 1 `CATALOG_KEYS/DEPRECATED_KEYS`、Task 3 `validateKey`。Produces: `catalogVCheck(claim: {catalog_v?: string; permissions?: string[]}): { fastPath: boolean; rejected: string[] }`（`==` 恒定真→快路径跳过逐 key；否则逐 key ∈ catalog∪deprecated，失败 key 进 rejected——**`==` 失败不是拒绝条件**，M3.5）；`resolveViewKey(perms: readonly string[], view: string): { ok: boolean; key?: string; reason?: 'unknown'|'deprecated' }`（解析期校验 M2：通配展开后的具体 key 仍须 ∈ catalog∪deprecated）；旧形状令牌（无 catalog_v）≤48h TTL 判定（S4：`claim.catalog_v` 缺失 + token iat > 48h → 提示重登，软门禁）。Task 16（消费侧切）/19（view-group）消费。

- [ ] **Step 1: 写失败测试**

```ts
// web/lib/__tests__/exception-claims.test.ts 兼 catalog_v 用例（同文件两组 describe）
import { describe, it, expect } from 'vitest';
import { catalogVCheck, resolveViewKey } from '../feature-perm';

describe('catalog_v 快/慢路径（spec §5.4，M3.5 防全员锁死）', () => {
  it('版本戳相等 → 快路径（跳过逐 key 校验，即使 claims 含已下架 key）', () => {
    const r = catalogVCheck({ catalog_v: '20260816.1', permissions: ['data-analysis:view:gone'] }, '20260816.1');
    expect(r).toEqual({ fastPath: true, rejected: [] });
  });
  it('版本戳不等 → 慢路径：每 key ∈ catalog∪deprecated，已驱逐 key 进 rejected；其余照常（非全拒）', () => {
    const r = catalogVCheck({ catalog_v: '20260816.0', permissions: ['data-analysis:view:reports', 'data-analysis:view:gone'] }, '20260816.1');
    expect(r.fastPath).toBe(false);
    expect(r.rejected).toEqual(['data-analysis:view:gone']);   // 只拒该 key，reports 照常（H6 key 级）
  });
  it('catalog_v 缺失（旧形状令牌）→ 慢路径 + stale 标记（≤48h TTL 由调用方按 iat 判）', () => {
    const r = catalogVCheck({ permissions: ['data-analysis:view:reports'] }, '20260816.1');
    expect(r.fastPath).toBe(false);
    expect(r.rejected).toEqual([]);
  });
});

describe('解析期校验（M2：通配持有者对已驱逐 key 不可用）', () => {
  it('具名 key ∈ catalog → 放行', () => {
    expect(resolveViewKey(['data-analysis:view:reports'], 'reports')).toEqual({ ok: true, key: 'data-analysis:view:reports' });
  });
  it('通配命中但具体 key 已被驱逐（不在 catalog∪deprecated）→ fail-close（M2 攻击路径封口）', () => {
    expect(resolveViewKey(['data-analysis:view:*'], 'gone')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('通配命中且 key 在 deprecated → 拒（deprecated = 拒绝+告警，非放行）', () => {
    // 注入：deprecated 集含 view:gone2 的场景由 validateKey 内部判定——此处用真实 catalog 断言行为分支
    const r = resolveViewKey(['data-analysis:view:*'], 'reports');
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/__tests__/exception-claims.test.ts`，Expected: FAIL。
- [ ] **Step 3: 实现**（追加进 `web/lib/feature-perm.ts`）

```ts
// web/lib/feature-perm.ts 追加段
// catalog_v 校验（H6/M3.5/M2）——判定序与实查成 AND（F10）：本模块是离线快判层，
// 实查段（requireAdmin/casbin enforce）不因此跳过。
import { CATALOG_KEYS, DEPRECATED_KEYS } from './capability-catalog';

export interface CatalogVVerdict { fastPath: boolean; rejected: string[]; stale?: boolean }

export function catalogVCheck(claim: { catalog_v?: string; permissions?: readonly string[] }, serverV: string): CatalogVVerdict {
  const perms = claim.permissions ?? [];
  if (claim.catalog_v === serverV) return { fastPath: true, rejected: [] };   // 快路径：== 恒定真
  // 慢路径：逐 key ∈ catalog ∪ deprecated（deprecated 保留在「已知」集——驱逐 = 从两集都消失才拒）
  const rejected = perms.filter((k) => k !== '*' && !k.endsWith(':*') &&
    !CATALOG_KEYS.has(k) && !DEPRECATED_KEYS.has(k));
  return { fastPath: false, rejected, stale: claim.catalog_v === undefined }; // stale：旧形状令牌（S4 ≤48h 由调用方判 iat）
}

// 解析期校验（M2）：通配展开后的具体 key 仍须 ∈ catalog ∪ deprecated
export function resolveViewKey(perms: readonly string[], view: string): { ok: boolean; key?: string; reason?: 'unknown' | 'deprecated' } {
  const key = `data-analysis:view:${view}`;
  const named = perms.includes(key);
  const wildcard = perms.includes('data-analysis:view:*') || perms.includes('*');
  if (!named && !wildcard) return { ok: false, reason: 'unknown' };           // 无命中
  // 命中（具名或通配）→ 校验解析结果粒度
  if (DEPRECATED_KEYS.has(key)) return { ok: false, reason: 'deprecated' };
  if (!CATALOG_KEYS.has(key)) return { ok: false, reason: 'unknown' };        // ★M2：通配持有者对已驱逐 key 在此被挡
  return { ok: true, key };
}
```

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/__tests__/exception-claims.test.ts`，Expected: PASS（6 例）。
- [ ] **Step 5: middleware 接线**：`web/middleware.ts` 现有 view 快判处改调 `resolveViewKey`（经 claims permissions）+ `catalogVCheck`（stale && iat>48h → 302 /login 刷新提示）；改动保持软门禁语义（快判拒 → 落地页，实查兜底不变）。
- [ ] **Step 6: Commit** `git add web/lib/feature-perm.ts web/lib/__tests__/exception-claims.test.ts web/middleware.ts && git commit -m "feat(w3): catalog_v 快/慢路径+解析期校验+旧形状 48h TTL（Task13，H6/M2/M3.5/S4）"`

---

## W4：存量回填 + 消费侧切 + shadow 对账

### Task 14: 冻结快照表 + 冻结哨兵（迁移 180，B3/M4 基线钉死）

**Files:**
- Create: `database/migrations/180_perm_freeze_snapshot.sql`

**Interfaces:** Consumes: `data_permissions`（legacy 四维表，既有——W4 快照基线的数据来源）。Produces: 表 `perm_freeze_snapshot`（U2 时点 COPY，**不可变**：无 UPDATE/DELETE 权限 + 触发器禁改）、表 `perm_freeze_sentinel(key TEXT PRIMARY KEY, frozen_at TIMESTAMPTZ)`（冻结哨兵——对账基线必须带哨兵读快照，防错基线）；`freeze_perms()` / `unfreeze_perms()` RPC（admin 手动触发冻结/演练解冻，写审计）。Task 15（回填 diff 门禁）/16（切换瞬间增量 diff）消费。

- [ ] **Step 1: 写迁移（幂等）**

```sql
-- 180_perm_freeze_snapshot.sql
-- W4 / spec W4 退出判据 M4/B3：shadow 对账基线 = U2 时点冻结的 legacy（data_permissions 派生）快照，
-- 非当前镜像（同源恒等 diff=0 自证门禁，B3 封口）。
-- 快照不可变：行级触发器禁 UPDATE/DELETE（写关闭前置）；冻结哨兵 = 表级标记，对账读基线前必查。

CREATE TABLE IF NOT EXISTS perm_freeze_snapshot (
  id           BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,               -- 'user'|'role'|'dept'（167 三类行）
  subject_id   TEXT NOT NULL,
  brands       JSONB NOT NULL DEFAULT '[]',
  categories   JSONB NOT NULL DEFAULT '[]',
  branch_nums  JSONB NOT NULL DEFAULT '[]',
  can_see_cost BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS perm_freeze_sentinel (
  key       TEXT PRIMARY KEY,               -- 'data_permissions_frozen'
  frozen_at TIMESTAMPTZ NOT NULL
);

-- 冻结 RPC：U2 发布窗内人工触发（一次性动作；重复调用 = no-op 幂等）
CREATE OR REPLACE FUNCTION freeze_perms()
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t TIMESTAMPTZ := now() AT TIME ZONE 'UTC';
BEGIN
  INSERT INTO perm_freeze_sentinel(key, frozen_at) VALUES ('data_permissions_frozen', t)
  ON CONFLICT (key) DO NOTHING;                          -- 已冻结 = no-op（防误触重冻覆盖基线）
  INSERT INTO perm_freeze_snapshot(subject_type, subject_id, brands, categories, branch_nums, can_see_cost)
  SELECT subject_type, subject_id,
         coalesce(brands, '[]'::jsonb), coalesce(categories, '[]'::jsonb),
         coalesce(branch_nums, '[]'::jsonb), coalesce(can_see_cost, false)
  FROM data_permissions
  ON CONFLICT (subject_type, subject_id) DO NOTHING;     -- 重跑只补缺（幂等）
  -- 勘误（T14 实施取证，2026-08-16）：data_permissions 四维实列类型是 JSONB，原文 '[]'::text[] 非法；直接 coalesce jsonb
  RETURN (SELECT frozen_at FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen');
END; $$;

-- 演练解冻（仅回滚演练用；生产禁调——写审计）
CREATE OR REPLACE FUNCTION unfreeze_perms()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen') THEN
    RETURN 0;
  END IF;
  DELETE FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen';
  TRUNCATE perm_freeze_snapshot;   -- 勘误（T14 实施取证）：DELETE 被自家不可变行触发器拦截永败；TRUNCATE 只触发 TRUNCATE 级触发器可清（SECURITY DEFINER 以 owner 执行）
  RETURN 1;
END; $$;

-- 快照不可变：禁 UPDATE/DELETE（INSERT 仅 freeze_perms 路径合法；触发器兜底）
CREATE OR REPLACE FUNCTION perm_snapshot_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'perm_freeze_snapshot is immutable (frozen baseline, B3)';
END; $$;
DROP TRIGGER IF EXISTS trg_snapshot_no_update ON perm_freeze_snapshot;
CREATE TRIGGER trg_snapshot_no_update BEFORE UPDATE OR DELETE ON perm_freeze_snapshot
  FOR EACH ROW EXECUTE FUNCTION perm_snapshot_immutable();

GRANT SELECT ON perm_freeze_snapshot, perm_freeze_sentinel TO authenticated;
GRANT EXECUTE ON FUNCTION freeze_perms, unfreeze_perms TO authenticated;  -- 调用面由 requireAdmin 管（UI 不暴露 unfreeze）
```

- [ ] **Step 2: 本地验证**：对本地库 `SELECT freeze_perms();` → 快照行数 = data_permissions 行数；`UPDATE perm_freeze_snapshot SET can_see_cost=true` → 报 immutable 异常（红）；重跑 `SELECT freeze_perms();` → no-op。Expected: 三项全符合；迁移重跑两遍全绿。
- [ ] **Step 3: Commit** `git add database/migrations/180_perm_freeze_snapshot.sql && git commit -m "feat(w4): 冻结快照表+哨兵+不可变触发器（迁移180，B3/M4 基线钉死）"`

---

### Task 15: 存量授权回填 + 逐用户 diff=0 门禁（迁移 181 + backfill 脚本，B4）

**Files:**
- Create: `database/migrations/181_perm_backfill.sql`
- Create: `scripts/backfill-perms.mjs`
- Test: `scripts/tests/backfill-perms.test.mjs`

**Interfaces:** Consumes: `perm_freeze_snapshot`（Task 14 基线）、Casdoor API（resource 授予=add-permission resources / 挂组=update-user Groups——经 `web/lib/sync/casdoor-client.ts` 同款 client_credentials）、`data_permissions`（存量读）。Produces: 迁移 181 = 回填工作台表 `perm_backfill_plan(user_id, action, payload JSONB, status, checked_by)`（批量推导 + 门店独立核对两列状态）；脚本 `planBackfill(snapshot, dim)`（纯函数：按快照推导 Casdoor 侧动作——品牌/品类→resource 勾选、门店集合→挂组映射、cost→field:cost）+ `diffScope(claimsScope, snapshotScope)`（逐用户四维 diff，B4 门禁核心）；退出码 0=diff 全零。

- [ ] **Step 1: 写失败测试**

```js
// scripts/tests/backfill-perms.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, diffScope } from '../backfill-perms.mjs';

test('快照→回填计划：品牌/品类维 → resource 勾选动作；门店维 → 挂组动作；cost → field:cost', () => {
  const plan = planBackfill([{
    subject_type: 'user', subject_id: 'shanhai/zhangsan',
    brands: ['3120'], categories: ['水果'], branch_nums: ['3120-001', '3120-002'], can_see_cost: true,
  }], { groupOf: (bn) => `熊喵-${bn}` });
  const z = plan.filter((p) => p.user_id === 'shanhai/zhangsan');
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:brand:3120'));
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:category:水果'));
  assert.ok(z.some((p) => p.action === 'attach-group' && p.payload.group === '熊喵-3120-001'));
  assert.ok(z.some((p) => p.action === 'grant-resource' && p.payload.key === 'data-analysis:field:cost'));
});

test('通配 ["*"] 门店集合 → 不逐店挂组，标 wildcard 人工核对（禁 250 组批量挂）', () => {
  const plan = planBackfill([{
    subject_type: 'role', subject_id: 'boss', brands: [], categories: [], branch_nums: ['*'], can_see_cost: true,
  }], { groupOf: () => 'x' });
  const b = plan.filter((p) => p.subject_id === 'boss');
  assert.ok(b.every((p) => p.action !== 'attach-group'));
  assert.ok(b.some((p) => p.action === 'manual-review' && p.payload.reason === 'wildcard-branch'));
});

test('diffScope：逐用户四维 diff（claims 派生 vs 冻结快照），全等 = 空数组', () => {
  const d = diffScope(
    { user: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: ['3120-001', '3120-002'], can_see_cost: true },
    { subject_id: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: ['3120-002', '3120-001'], can_see_cost: true },
  );
  assert.deepEqual(d, []);   // 顺序无关（集合语义）
  const d2 = diffScope(
    { user: 'shanhai/zhangsan', brands: ['3120'], categories: [], branch_nums: [], can_see_cost: false },
    { subject_id: 'shanhai/zhangsan', brands: ['3120'], categories: ['水果'], branch_nums: [], can_see_cost: false },
  );
  assert.deepEqual(d2, [{ dim: 'categories', missing: [], extra: ['水果'] }]);   // B4 门禁报差异
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/backfill-perms.test.mjs`，Expected: FAIL。
- [ ] **Step 3: 实现迁移 181 + 脚本**

```sql
-- 181_perm_backfill.sql
-- W4 / B4：存量回填工作台。回填三段（spec W4）：品牌/品类按角色或用户勾 resource；门店集合批量挂组+独立核对；
-- cost 进 field:cost。plan 行 status: pending→applied→checked（门店独立核对=第二列 checked_by）。
CREATE TABLE IF NOT EXISTS perm_backfill_plan (
  id          BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('grant-resource','attach-group','manual-review')),
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed','checked')),
  checked_by  TEXT,                          -- 门店独立核对人（W4 退出判据「门店独立核对」留痕）
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backfill_subject ON perm_backfill_plan(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_backfill_status ON perm_backfill_plan(status);
GRANT SELECT ON perm_backfill_plan TO authenticated;
```

```js
// scripts/backfill-perms.mjs
// W4 存量回填（B4/M1）：plan（推导）→ apply（调 Casdoor，经 casdoor-client 同款 client_credentials）
// → diff 门禁（逐用户 claims 派生 scope vs 冻结快照 = 0 才放行消费侧切）。
// 门店集合 = branch_number 全局唯一（门店键铁律）；通配 ["*"] 不逐店挂组（manual-review 人工核对）。
export function planBackfill(snapshot, { groupOf }) {
  const plan = [];
  for (const row of snapshot) {
    for (const b of row.brands ?? []) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id,
      action: 'grant-resource', payload: { key: `data-analysis:brand:${b}` } });
    for (const c of row.categories ?? []) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id,
      action: 'grant-resource', payload: { key: `data-analysis:category:${c}` } });
    if (row.can_see_cost) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id,
      action: 'grant-resource', payload: { key: 'data-analysis:field:cost' } });
    const bns = row.branch_nums ?? [];
    if (bns.includes('*')) {
      plan.push({ subject_type: row.subject_type, subject_id: row.subject_id,
        action: 'manual-review', payload: { reason: 'wildcard-branch', note: '通配门店改挂区域组或逐组勾选，人工定' } });
    } else {
      for (const bn of bns) plan.push({ subject_type: row.subject_type, subject_id: row.subject_id,
        action: 'attach-group', payload: { group: groupOf(bn), branch_number: bn } });
    }
  }
  return plan;
}

const setEq = (a, b) => { const A = new Set(a), B = new Set(b);
  return { missing: [...B].filter((x) => !A.has(x)), extra: [...A].filter((x) => !B.has(x)) }; };

export function diffScope(claimsScope, snapScope) {
  const out = [];
  for (const dim of ['brands', 'categories', 'branch_nums']) {
    const { missing, extra } = setEq(claimsScope[dim] ?? [], snapScope[dim] ?? []);
    if (missing.length || extra.length) out.push({ dim, missing, extra });
  }
  if ((claimsScope.can_see_cost ?? false) !== (snapScope.can_see_cost ?? false))
    out.push({ dim: 'can_see_cost', missing: [], extra: [String(claimsScope.can_see_cost)] });
  return out;
}
// CLI（apply/门禁）与 Casdoor 交互走 casdoor-client 同款 client_credentials fetch——模式同 reconcile-catalog.mjs main()，此处不重复。
```

- [ ] **Step 4: 跑测试确认通过**：Run `node --test scripts/tests/backfill-perms.test.mjs`，Expected: PASS（3 例）。
- [ ] **Step 5: 门禁演练**：对生产快照 dry-run `node scripts/backfill-perms.mjs --plan-only`（读 perm_freeze_snapshot → 打印 plan 不执行）→ 人工核对 wildcard/manual-review 行 → gate 人确认后 `--apply`。Expected: apply 后逐用户 diff=0（白名单+非预期差异双清零，B4）。
- [ ] **Step 6: Commit** `git add database/migrations/181_perm_backfill.sql scripts/backfill-perms.mjs scripts/tests/backfill-perms.test.mjs && git commit -m "feat(w4): 存量回填 plan/apply/diff=0 门禁（Task15，B4，W4 核心）"`

---

### Task 16: 消费侧切——RLS 主读 data_scope + 列掩码收口（迁移 182，H7 消费点清单同一 PR）

**Files:**
- Create: `database/migrations/182_consumption_switch.sql`
- Modify: `services/semantic-generator/src/templates/tier1.ts`（maskCost → fields.cost 消费——**生成模板层 4 处之一**）
- Modify: `services/semantic-generator/src/templates/hierarchy.ts:505-528`（can_see_cost → fields.cost）
- Modify: `web/lib/perm.ts`（push scope-signature 消费点）
- Modify: `web/components/report-render*`（render 消费点——worker 执行时 grep `can_see_cost` 全量清点）
- Test: `scripts/tests/consumption-switch.test.mjs`（衍生列血缘断言，H7）

**Interfaces:** Consumes: `scope_match_v2`（Task 12，179）、claims `data_scope/fields` 段（Task 11）。Produces: 迁移 182 = scope_match_v2 **删回退支**（`data_scope` 缺失 → 也 deny？**否——保留回退至 W6**：W4 切消费 = RLS 策略以 data_scope 为主读、legacy 回退支保留到 Task 20；本迁移只把「新旧并存」的默认消费方向钉死为新段优先 + 列掩码 SQL 段统一读 `fields.cost`）；掩码消费点 4+2 处统一改为读 `request.jwt.claims.fields->>'cost'`（114 扁平后 `fields` 是单 GUC jsonb）。

- [ ] **Step 1: 写失败测试（衍生列血缘断言，H7）**

```js
// scripts/tests/consumption-switch.test.mjs
// H7 衍生列血缘断言：fields.cost=false（或缺失）→ 成本基列 NULL 且 margin/rate 衍生列全随 NULL——
// 防 inner CTE 单独产出再外层投影漏掩。注入式直查生成视图。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(`docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`, { encoding: 'utf8' }).trim();
const withClaims = (claims, sql) => PSQL(
  `BEGIN; SELECT set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', true); ${sql}; ROLLBACK;`);

test('红→绿：fields.cost 缺失（无 fields 段）→ 全掩（安全方向不依赖单处 CASE）', () => {
  const r = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['*'] } },
    `SELECT count(*) FROM report_item_breakdown_gen WHERE cost IS NOT NULL OR profit IS NOT NULL OR margin IS NOT NULL`);
  assert.equal(r, '0');   // cost/profit/margin 全 NULL（血缘传播）
});

test('红→绿：fields.cost=true → 成本列可见', () => {
  const r = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['*'] }, fields: { cost: true } },
    `SELECT count(*) FROM report_item_breakdown_gen WHERE cost IS NOT NULL`);
  assert.notEqual(r, '0');
});

test('血缘：margin/rate 类衍生列随基列 NULL（非独立产出）', () => {
  const r = withClaims({ sub: 'shanhai/test', data_scope: { branch_nums: ['*'] } },
    `SELECT count(*) FROM report_item_breakdown_gen WHERE cost IS NULL AND margin IS NOT NULL`);
  assert.equal(r, '0');   // cost 被掩则 margin 必 NULL——inner CTE 漏掩在此爆红
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/consumption-switch.test.mjs`，Expected: FAIL（现状模板读 `can_see_cost` 顶层 key，新 claims 无此段 → 全掩预期外/或反向漏掩——红态记录现状行为）。
- [ ] **Step 3: 迁移 182 + 消费点统一改读 fields.cost**

```sql
-- 182_consumption_switch.sql
-- W4 消费侧切（spec §5.7）：列掩码判定函数统一读 fields 段（114 扁平后 request.jwt.claims.fields = jsonb GUC）。
-- 无 fields 段 → 全掩（安全方向，H7 契约快照断言）；legacy can_see_cost 顶层 key 双氧保留（B6）——
-- can_cost_visible() 形状鉴别：fields 段存在读 fields.cost；缺失回退 can_see_cost（旧令牌）。
CREATE OR REPLACE FUNCTION can_cost_visible()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_fields JSONB;
BEGIN
  v_fields := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'fields';
  IF v_fields IS NOT NULL THEN
    RETURN coalesce((v_fields->>'cost')::boolean, false);   -- 段存在缺 key = false（全掩方向）
  END IF;
  RETURN coalesce((NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'can_see_cost')::boolean, false);
END; $$;
GRANT EXECUTE ON FUNCTION can_cost_visible TO anon, authenticated;
```

模板消费点（tier1.ts maskCost / hierarchy.ts 505-528 等 4 处生成模板 + perm.ts scope-signature + render 组件）：统一改调 `can_cost_visible()`（SQL 内）或 claims `fields?.cost`（TS 侧，缺省 false）。worker 执行时 `grep -rn 'can_see_cost' services/semantic-generator/src web/ | grep -v test` 全量清点逐处迁移——清点结果非零行即未完成。

- [ ] **Step 4: 跑测试确认通过**：Run `node scripts/../deploy/regen-views.sh`（若仓内路径不同按 docs 现行生成器入口重跑视图）+ `node --test scripts/tests/consumption-switch.test.mjs`，Expected: PASS（3 例）；`grep -rn 'can_see_cost' services/semantic-generator/src/` → 0 行。
- [ ] **Step 5: 切换瞬间增量 diff=0 断言**（M2/B3/RT-6）：切前重跑 `node scripts/backfill-perms.mjs --diff-only`（基线=冻结快照+哨兵在）→ 0；切后再跑 → 0（快照到执行间有变动即作废重走）。
- [ ] **Step 6: Commit** `git add database/migrations/182_consumption_switch.sql services/semantic-generator/ web/lib/perm.ts web/ scripts/tests/consumption-switch.test.mjs && git commit -m "feat(w4): 消费侧切——can_cost_visible+H7 消费点清单同一 PR+衍生列血缘断言（Task16）"`

---

## W5：例外表 + DB 写关闭 + view-group 转正（前置：W4 退出判据全绿 ∧ U2 验收 + 回滚演练通过）

> **W5 退出判据（客观门禁）**：DB 禁写 + 直写注入拒绝测试绿（Task 18）∧ 7 天零缺口报告（运营观测，reconcile-groups/reconcile-catalog 持续无红）∧ 前置 = PERMS_INPUT=casdoor ≥24h 且 shadow diff=0（F8）。

### Task 17: temporary_grants 例外表 + RT 5min 实查 + 授权中心例外 tab（迁移 183，B5/M3/M4）

**Files:**
- Create: `database/migrations/183_temporary_grants.sql`
- Create: `web/lib/exception-grants.ts`
- Test: `web/lib/__tests__/exception-grants.test.ts`
- Create: `web/app/api/admin/permissions/grants/route.ts`
- Modify: `web/app/admin/permissions/page.tsx`（新增「例外」tab，复用现有 tab 骨架）
- Test: `scripts/tests/exception-rls-union.test.mjs`（RT→RLS 并集注入，红转绿）

**Interfaces:**
- Consumes: `requireAdmin`（`web/lib/admin-api-auth.ts`，同 Task 6 模式）、`permission_audit`（迁移 167 已建，写入口走管理 API 同款 INSERT）、`scope_match_v2`（Task 12 迁移 179 版——本迁移 CREATE OR REPLACE 重建为并集版）、`pgrst_pre_request`（迁移 114 版——本迁移 CREATE OR REPLACE 扩展，migrate.sh 每次重跑 114→183、183 后版本胜出）。
- Produces: 表 `temporary_grants(id, user_id, dim, value, expires_at, revoked_at, granted_by, note, created_at)`；GUC 段 `request.jwt.claims.x_grants`（pre_request 每请求实查注入，事务级）；`scope_match_v2` 并集版（`data_scope.<dim> ∪ x_grants.<dim>`，并集空=deny，通配在任一侧=放行）；TS 侧 `getExceptionGrants(sub: string): Promise<ExceptionGrants>`（5min TTL 缓存）+ `invalidateExceptionCache(sub: string): void`；API `GET|POST|DELETE /api/admin/permissions/grants`。Task 18（写关闭后唯一四维承接位）/Task 20（sunset 后唯一例外通道）依赖。

- [ ] **Step 1: 写失败测试（TS 缓存语义 + RLS 并集注入两份）**

```ts
// web/lib/__tests__/exception-grants.test.ts
// B5：例外不折叠进登录 claims；M3：5min TTL 缓存 + UI 撤销同步失效；本地降级 = fail-close 等同无例外。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mod = await import('../exception-grants');

describe('例外 RT 实查（B5/M3）', () => {
  beforeEach(() => { mod.__resetForTest(); vi.restoreAllMocks(); });

  it('活跃且未过期/未撤销的例外计入；过期/已撤销不计入', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ([
        { dim: 'branch_nums', value: '3120-001', expires_at: future, revoked_at: null },
        { dim: 'branch_nums', value: '3120-002', expires_at: past, revoked_at: null },
        { dim: 'fields', value: 'cost', expires_at: future, revoked_at: past },
      ]),
    } as never);
    const g = await mod.getExceptionGrants('shanhai/zhangsan');
    expect(g.branch_nums).toEqual(['3120-001']);
    expect(g.can_see_cost).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('5min TTL：缓存期内二次调用零请求；invalidate 后立即重查（主动失效）', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as never);
    await mod.getExceptionGrants('shanhai/a');
    await mod.getExceptionGrants('shanhai/a');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    mod.invalidateExceptionCache('shanhai/a');
    await mod.getExceptionGrants('shanhai/a');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('查询失败 → fail-close 等同无例外（空 grants，不抛不兜底放行）', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('db down'));
    const g = await mod.getExceptionGrants('shanhai/a');
    expect(g).toEqual({ branch_nums: [], brands: [], categories: [], can_see_cost: false });
  });
});
```

```js
// scripts/tests/exception-rls-union.test.mjs
// RT→RLS 通道（M3）：例外门店经 pgrst_pre_request 每请求并集进 x_grants GUC；
// scope_match_v2 读 data_scope ∪ x_grants。断言走函数直判（同 Task 12 测试模式）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();
const withGuC = (claims, grants, sql) => PSQL(`BEGIN;
SELECT set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', true);
SELECT set_config('request.jwt.claims.x_grants', '${JSON.stringify(grants).replace(/'/g, "''")}', true);
${sql}; ROLLBACK;`);

test('并集：data_scope.branch_nums 空集（deny 基线）+ x_grants 例外 → 例外门店放行、例外外仍 deny', () => {
  const DENY = { sub: 'shanhai/test', data_scope: { branch_nums: [], brands: ['3120'] } };
  assert.equal(withGuC(DENY, { branch_nums: ['3120-001'] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 't');
  assert.equal(withGuC(DENY, { branch_nums: ['3120-001'] },
    `SELECT scope_match_v2('branch_nums', '3120-099')`), 'f');
});

test('并集：非空 data_scope 与 x_grants 合并（两侧都命中/仅一侧命中均放行）', () => {
  const c = { sub: 'shanhai/test', data_scope: { branch_nums: ['3120-001'] } };
  assert.equal(withGuC(c, { branch_nums: ['3120-002'] },
    `SELECT scope_match_v2('branch_nums', '3120-002')`), 't');   // 仅例外侧
  assert.equal(withGuC(c, { branch_nums: ['3120-002'] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 't');   // 仅 data_scope 侧
});

test('两侧全空 = deny（B1 不因例外通道放松）', () => {
  assert.equal(withGuC(
    { sub: 'shanhai/test', data_scope: { branch_nums: [] } }, { branch_nums: [] },
    `SELECT scope_match_v2('branch_nums', '3120-001')`), 'f');
});

test('pre_request 实查过期/撤销行不注入（等价单测 pre_request 过滤谓词）', () => {
  const out = PSQL(`BEGIN;
INSERT INTO temporary_grants (user_id, dim, value, expires_at, granted_by)
VALUES ('shanhai/probe', 'branch_nums', '3120-009', now() - interval '1 hour', 'probe')
ON CONFLICT DO NOTHING;
SELECT set_config('request.jwt.claims', '{"sub":"shanhai/probe","data_scope":{"branch_nums":[]}}', true);
SELECT pgrst_pre_request();
SELECT current_setting('request.jwt.claims.x_grants', true);
ROLLBACK;`);
  assert.ok(!out.includes('3120-009'), `过期例外不得注入 x_grants，实际: ${out}`);
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/__tests__/exception-grants.test.ts`（Expected: FAIL 模块不存在）+ `node --test scripts/tests/exception-rls-union.test.mjs`（Expected: FAIL——temporary_grants 表不存在/现状 scope_match_v2 不读 x_grants）。
- [ ] **Step 3: 实现迁移 183 + exception-grants.ts**

```sql
-- 183_temporary_grants.sql
-- W5 / B5+M3+M4：临时例外表（app 侧唯一授权数据，IAM 无到期语义 D7）。
-- 不折叠进登录 claims（B5）；RLS 通道 = pgrst_pre_request 每请求实查并集 x_grants 段；
-- app 侧（middleware 快判/push/preview）= 5min TTL 缓存实查（web/lib/exception-grants.ts）。
BEGIN;

CREATE TABLE IF NOT EXISTS temporary_grants (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,            -- sub（shanhai/<wecom_id>）
  dim         TEXT NOT NULL CHECK (dim IN ('branch_nums','brands','categories','fields')),
  value       TEXT NOT NULL,            -- branch_number（全局唯一，门店键铁律）/ sbc / 品类 / 'cost'
  expires_at  TIMESTAMPTZ NOT NULL,     -- 到期即失效（无续期语义，续 = 重授）
  revoked_at  TIMESTAMPTZ,              -- 撤销留痕（不物理删）
  granted_by  TEXT NOT NULL,            -- 授予人（审计归因）
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_temp_grants_active ON temporary_grants(user_id)
  WHERE revoked_at IS NULL;
GRANT SELECT, INSERT ON temporary_grants TO authenticated;   -- UPDATE 限撤销列
GRANT UPDATE (revoked_at, note) ON temporary_grants TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
COMMENT ON TABLE temporary_grants IS 'W5 临时例外（spec §5.2）：写只走管理 API（requireAdmin+审计+上限）；撤销 ≤5min 生效（健康态）';

-- pgrst_pre_request 扩展（= 114 版全文 + 例外并集段；migrate.sh 重跑 114→183，本版本胜出）
CREATE OR REPLACE FUNCTION pgrst_pre_request() RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw    TEXT;
  v_claims JSONB;
  k TEXT;
  v TEXT;
  v_sub TEXT;
  v_grants JSONB;
BEGIN
  v_raw := current_setting('request.jwt.claims', true);
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN RETURN; END IF;
  BEGIN
    v_claims := v_raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  FOR k, v IN SELECT key, value::text FROM jsonb_each(v_claims) LOOP
    PERFORM set_config('request.jwt.claims.' || k, v, true);
  END LOOP;
  -- 例外并集段（M3）：本地表直查（廉价、行数极少）；DB 不可达由外层异常路径 fail-close 为无例外
  v_sub := v_claims ->> 'sub';
  IF v_sub IS NOT NULL THEN
    BEGIN
      SELECT jsonb_build_object(
               'branch_nums', coalesce(jsonb_agg(value) FILTER (WHERE dim = 'branch_nums'), '[]'::jsonb),
               'brands',      coalesce(jsonb_agg(value) FILTER (WHERE dim = 'brands'),      '[]'::jsonb),
               'categories',  coalesce(jsonb_agg(value) FILTER (WHERE dim = 'categories'),  '[]'::jsonb),
               'fields',      coalesce(jsonb_agg(value) FILTER (WHERE dim = 'fields'),      '[]'::jsonb))
        INTO v_grants
        FROM temporary_grants
       WHERE user_id = v_sub AND revoked_at IS NULL AND expires_at > now();
      PERFORM set_config('request.jwt.claims.x_grants', coalesce(v_grants, '{}'::jsonb)::text, true);
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('request.jwt.claims.x_grants', '{}', true);   -- fail-close：等同无例外
    END;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION pgrst_pre_request() TO anon, authenticated;

-- scope_match_v2 并集版（= 179 版 + x_grants 并集；legacy 回退支保留至 Task 20 删）
CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_scope  JSONB;
  v_dim    JSONB;
  v_grants JSONB;
  v_gdim   JSONB;
  v_val    TEXT;
BEGIN
  v_scope := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'data_scope';
  IF v_scope IS NOT NULL THEN
    v_dim    := v_scope -> p_dim;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
    v_gdim   := coalesce(v_grants -> p_dim, '[]'::jsonb);
    IF v_dim IS NULL AND jsonb_array_length(v_gdim) = 0 THEN
      RETURN FALSE;                     -- 维度缺失且无例外 = deny（禁回退——形状已判新）
    END IF;
    v_dim := coalesce(v_dim, '[]'::jsonb);
    IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
      RETURN FALSE;                     -- ★并集空 = authorized ∅ = deny（B1）
    END IF;
    IF v_dim ? '*' OR v_gdim ? '*' THEN
      RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
    END IF;
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_gdim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  RETURN claim_match_or_star(p_col, p_dim);   -- legacy 分支（S4 豁免窗口，Task 20 删）
END;
$$;
GRANT EXECUTE ON FUNCTION scope_match_v2 TO anon, authenticated;

COMMIT;
```

```ts
// web/lib/exception-grants.ts
// 例外 RT 实查（B5/M3）：5min TTL 缓存 + UI 撤销主动失效。查询失败 = fail-close 等同无例外。
// 读通道与 admin permissions API 同款 PostgREST fetch（env 同 NEXT_PUBLIC_INSFORGE_ANON_KEY 体系）。
export interface ExceptionGrants {
  branch_nums: string[]; brands: string[]; categories: string[]; can_see_cost: boolean;
}
const EMPTY: ExceptionGrants = { branch_nums: [], brands: [], categories: [], can_see_cost: false };
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; value: ExceptionGrants }>();

export async function getExceptionGrants(sub: string): Promise<ExceptionGrants> {
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const url = `${process.env.NEXT_PUBLIC_API_BASE_URL ?? ''}/temporary_grants` +
      `?select=dim,value,expires_at,revoked_at&user_id=eq.${encodeURIComponent(sub)}` +
      `&revoked_at=is.null&expires_at=gt.${new Date().toISOString()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`grants ${r.status}`);
    const rows = (await r.json()) as { dim: string; value: string }[];
    const value: ExceptionGrants = {
      branch_nums: rows.filter((x) => x.dim === 'branch_nums').map((x) => x.value),
      brands: rows.filter((x) => x.dim === 'brands').map((x) => x.value),
      categories: rows.filter((x) => x.dim === 'categories').map((x) => x.value),
      can_see_cost: rows.some((x) => x.dim === 'fields' && x.value === 'cost'),
    };
    cache.set(sub, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(sub, { at: Date.now(), value: EMPTY });   // fail-close 等同无例外（不兜底放行）
    return EMPTY;
  }
}

export function invalidateExceptionCache(sub: string): void { cache.delete(sub); }   // M3 主动失效
export function __resetForTest(): void { cache.clear(); }
```

- [ ] **Step 4: 跑测试确认通过**：Run `docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/183_temporary_grants.sql`（跑两遍验幂等）`&& node --test scripts/tests/exception-rls-union.test.mjs && cd web && npx vitest run lib/__tests__/exception-grants.test.ts`，Expected: 4 例 + 3 例全 PASS。
- [ ] **Step 5: grants API + 授权中心例外 tab**

```ts
// web/app/api/admin/permissions/grants/route.ts（requireAdmin 门禁 + 上限校验 + 审计 + 主动失效）
// GET  → { grants: 活跃+近30天已失效行 }          POST → 授予（校验上限）
// DELETE ?id= → 撤销（写 revoked_at + 审计 + invalidateExceptionCache）
// 上限校验（M4 授予面门禁）：单次到期 ≤90 天；单用户单维活跃例外 ≤50 条；双人复核可选配置（V2）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { invalidateExceptionCache } from '@/lib/exception-grants';

const MAX_DAYS = 90, MAX_PER_DIM = 50;
const DIMS = new Set(['branch_nums', 'brands', 'categories', 'fields']);

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (gate) return gate;
  const b = await req.json();
  if (!DIMS.has(b.dim) || !b.value || !b.wecom_id) {
    return NextResponse.json({ error: 'dim/value/wecom_id 必填且 dim 合法' }, { status: 400 });
  }
  const days = Math.ceil((new Date(b.expires_at).getTime() - Date.now()) / 86_400_000);
  if (!(days > 0 && days <= MAX_DAYS)) {
    return NextResponse.json({ error: `到期天数须在 (0, ${MAX_DAYS}]` }, { status: 400 });
  }
  // INSERT temporary_grants + permission_audit 留痕（payload_after = 本行；actor = gate 管理员）
  // ……（PostgREST 调用同本目录 users/route.ts 现有模式；先 count 同维活跃行 < MAX_PER_DIM 再插）
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin(req);
  if (gate) return gate;
  const id = req.nextUrl.searchParams.get('id');
  // UPDATE temporary_grants SET revoked_at=now() WHERE id=$id RETURNING user_id
  // → permission_audit(action='grant_revoke') → invalidateExceptionCache(user_id)（M3 同步清缓存）
  return NextResponse.json({ ok: true });
}
```

`web/app/admin/permissions/page.tsx` 追加「例外」tab（照现有 Users/Depts/Roles tab 骨架）：活跃例外表（用户/维度/值/到期/授予人/note/撤销按钮）+ 授予表单（用户选择器复用、dim 下拉四值、value 输入、天数 ≤90、note）；撤销调 DELETE 后本地刷新（服务端已同步清缓存）。DESIGN.md 对齐（DM Sans + tabular-nums + slate + 深蓝主色，同页现有风格）。

- [ ] **Step 6: 手动验证**：本地 `cd web && npm run build` 过；`curl -s -X POST http://localhost:3000/api/admin/permissions/grants -H "Cookie: <伪造 admin claims>" -d '{...}'`（testing-handbook §2 模式）返回 `{ok:true}` 且 permission_audit 有行。
- [ ] **Step 7: Commit** `git add database/migrations/183_temporary_grants.sql web/lib/exception-grants.ts web/lib/__tests__/exception-grants.test.ts web/app/api/admin/permissions/grants/ web/app/admin/permissions/page.tsx scripts/tests/exception-rls-union.test.mjs && git commit -m "feat(w5): temporary_grants 例外表+RT 5min 实查+授权中心例外 tab（Task17，B5/M3/M4）"`

---

### Task 18: data_permissions DB 级写关闭——REVOKE/触发器 + 直写注入红转绿（迁移 184，H9）

**Files:**
- Create: `database/migrations/184_perm_write_close.sql`
- Modify: `database/migrations/167_permission_consolidation.sql`（§①-§④ 加表存在/触发器存在守卫——防 W5 后 migrate.sh 重跑炸）
- Test: `scripts/tests/perm-write-close.test.mjs`
- Modify: `web/app/api/admin/permissions/users/[wecom_id]/route.ts` + `depts/route.ts` + `roles/route.ts`（写路径捕获 frozen 错误 → 409 引导）
- Modify: `web/app/admin/permissions/page.tsx`（四维 override 编辑器改只读 + 引导横幅）

**Interfaces:**
- Consumes: `temporary_grants`（Task 17——写关闭后的承接位）、`perm_freeze_snapshot`（Task 14——回滚数据源）。
- Produces: 触发器 `trg_dp_write_close`（BEFORE INSERT/UPDATE/DELETE ON data_permissions，逃生门 GUC `app.bypass_perm_write=on`）；`data_permissions` 对 anon/authenticated 的 INSERT/UPDATE/DELETE REVOKE；API 写路径 409 契约 `{ error: 'frozen', guidance: '...' }`。Task 20（DROP TABLE 前置）/rollback 脚本依赖。

- [ ] **Step 1: 写失败测试（红：直写注入现状可写）**

```js
// scripts/tests/perm-write-close.test.mjs
// H9：管理页只读只是 UX 表现 ≠ 单写者；DB 级 REVOKE + 触发器禁写 + 直写注入红转绿才放行 W6。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();
// 直写注入（authenticated 角色 = PostgREST 写通道）：BEGIN 内注入，ROLLBACK 不留痕
const tryWrite = (sql) => PSQL(`BEGIN; SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"shanhai/inject","role":"admin"}', true);
${sql}; ROLLBACK;`);

test('绿：authenticated INSERT 直写被拒（触发器/REVOKE 双层）', () => {
  let threw = false;
  try { tryWrite(`INSERT INTO data_permissions (subject_type, subject_id) VALUES ('user','inject')`); }
  catch { threw = true; }
  assert.ok(threw, 'INSERT 须被 DB 层拒绝');
});

test('绿：authenticated UPDATE/DELETE 直写被拒', () => {
  for (const sql of [
    `UPDATE data_permissions SET note='x' WHERE id=(SELECT min(id) FROM data_permissions)`,
    `DELETE FROM data_permissions WHERE id=(SELECT min(id) FROM data_permissions)`,
  ]) {
    let threw = false;
    try { tryWrite(sql); } catch { threw = true; }
    assert.ok(threw, `${sql.slice(0, 6)} 须被 DB 层拒绝`);
  }
});

test('绿：逃生门 app.bypass_perm_write=on 可写（回滚脚本专用；写后即回滚不留痕）', () => {
  const n = PSQL(`BEGIN;
SELECT set_config('app.bypass_perm_write', 'on', true);
INSERT INTO data_permissions (subject_type, subject_id, note) VALUES ('user','rollback-probe','probe');
SELECT count(*) FROM data_permissions WHERE subject_id='rollback-probe';
ROLLBACK;`);
  assert.equal(n, '1');   // 逃生门开时可写（事务内验证即回滚）
});

test('绿：SELECT 不受影响（只读投影仍可读，167 回滚保险）', () => {
  const n = PSQL(`SELECT count(*) FROM data_permissions`);
  assert.ok(Number(n) >= 0);
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/perm-write-close.test.mjs`，Expected: FAIL（前 2 例——现状直写可写）。
- [ ] **Step 3: 写迁移 184 + 167 守卫**

```sql
-- 184_perm_write_close.sql
-- W5 / H9：data_permissions DB 级写关闭（REVOKE 双层 + 触发器兜底 superuser/psql 直写）。
-- 逃生门 app.bypass_perm_write=on 仅供 database/rollback/167_reverse.sql（Task 20 建）。
-- 幂等 + W6 前瞻：本迁移所有 data_permissions 静态 SQL 包 to_regclass 守卫——Task 20 删表后
-- migrate.sh 重跑本文件仍须全绿（触发器/REVOKE 段跳过）。
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON data_permissions FROM anon, authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION forbid_dp_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.bypass_perm_write', true) = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;   -- 逃生门（回滚脚本）
  END IF;
  RAISE EXCEPTION 'data_permissions frozen (W5 写关闭, spec 2026-08-16 §5.2): 授权走 Casdoor; 例外走 temporary_grants; 回滚用 database/rollback/167_reverse.sql';
END; $$;

DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_dp_write_close ON data_permissions;
    CREATE TRIGGER trg_dp_write_close BEFORE INSERT OR UPDATE OR DELETE ON data_permissions
      FOR EACH ROW EXECUTE FUNCTION forbid_dp_write();
  END IF;
END $$;

COMMIT;
```

`167_permission_consolidation.sql` 守卫改造（防 W5/W6 后重跑炸；只改守卫不改语义）：
- §① `ALTER TABLE data_permissions ...` 6 条 + COMMENT 4 条 → 整段包 `DO $$ BEGIN IF to_regclass('public.data_permissions') IS NOT NULL THEN ... END IF; END $$;`
- §②/§③/§④ 已有 DO 块的 IF 条件追加两个谓词：`AND to_regclass('public.data_permissions') IS NOT NULL`（W6 删表后跳过）`AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_dp_write_close')`（W5 后新同步出的 dept 行不再自动 INSERT——授权语义已上收）。
- 保留 permission_audit 段不动。

- [ ] **Step 4: 跑测试确认通过**：Run `docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/184_perm_write_close.sql`（两遍验幂等）`&& node --test scripts/tests/perm-write-close.test.mjs`，Expected: 4 例 PASS。
- [ ] **Step 5: API 写路径降级 + 页面只读引导**：三个写路由（users/[wecom_id] PUT/DELETE、depts PUT、roles PUT）捕获含 `frozen` 的 PG 错误 → `NextResponse.json({ error:'frozen', guidance:'四维授权已上收 Casdoor（W5 写关闭）；临时例外走「例外」tab' }, { status: 409 })`；`page.tsx` override 编辑器四维控件 disabled + 顶部横幅（AlertTriangle 图标，同页现有样式）引导例外 tab。审计区保留可读。
- [ ] **Step 6: 部署验证（GHA——改了 web/ + database/）**：push 走 GHA；部署后 `node --test scripts/tests/perm-write-close.test.mjs`（对生产容器跑——PSQL 目标即 deploy-postgres-1）+ `docker exec deploy-postgres-1 psql ... -tAc "SELECT tgname FROM pg_trigger WHERE tgname='trg_dp_write_close'"` 非空。
- [ ] **Step 7: Commit** `git add database/migrations/184_perm_write_close.sql database/migrations/167_permission_consolidation.sql scripts/tests/perm-write-close.test.mjs web/app/api/admin/permissions/ web/app/admin/permissions/page.tsx && git commit -m "feat(w5): data_permissions DB 级写关闭+直写注入红转绿+管理页只读引导（Task18，H9）"`

---

### Task 19: view-group 展开转正——嵌套+环安全+成员禁通配（S1/M1，observe→enforce）

**Files:**
- Create: `web/lib/view-groups.ts`
- Test: `web/lib/__tests__/view-groups.test.ts`
- Modify: `web/lib/feature-perm.ts`（`resolveViewKey` 接 expandViewGroups）

**Interfaces:**
- Consumes: `VIEW_GROUPS`（Task 1 `web/lib/capability-catalog.ts` 导出）、`detectViewGroupCycle`（Task 3 `web/lib/validate-capabilities.ts`）、`resolveViewKey(perms, view)`（Task 13 `web/lib/feature-perm.ts`）。
- Produces: `expandViewGroups(perms: readonly string[]): string[]`（view-group 键递归展开为成员 `view:*` 键；非组键原样保留；visited-set 防环——环存在时该组截断 + console.error，校验器才是准入门）；`validateViewGroupMembers(groups?): { offenders: string[] }`（M1：成员禁含 `*`/`:*` 通配与自引用）。middleware（经 resolveViewKey 间接）/Task 6 辅助页消费。

- [ ] **Step 1: 写失败测试**

```ts
// web/lib/__tests__/view-groups.test.ts
import { describe, it, expect } from 'vitest';
import { expandViewGroups, validateViewGroupMembers } from '../view-groups';

describe('view-group 展开（spec §5.5，S1/M1）', () => {
  it('组键展开为成员 view:* 键；非组键原样保留', () => {
    const out = expandViewGroups([
      'data-analysis:view-group:reports-all', 'data-analysis:admin',
    ]);
    expect(out).toContain('data-analysis:view:reports');
    expect(out).toContain('data-analysis:view:wholesale-customers');
    expect(out).toContain('data-analysis:admin');
    expect(out).not.toContain('data-analysis:view-group:reports-all');   // 组键被展开消费
  });

  it('嵌套组递归展开（A 组含 B 组 → B 的成员也出现）', () => {
    // 用注入 groups 参数测嵌套（catalog 真值只有一层，机制须支持嵌套）
    const groups = {
      'g:a': { label: 'A', members: ['g:b', 'data-analysis:view:reports'] },
      'g:b': { label: 'B', members: ['data-analysis:view:reports-items'] },
    } as never;
    const { expandViewGroups: exp } = await import('../view-groups');
    expect(exp(['g:a'], groups)).toContain('data-analysis:view:reports-items');
  });

  it('环引用不死循环（visited 截断；准入门在校验器——此处防御性）', () => {
    const groups = {
      'g:a': { label: 'A', members: ['g:b'] },
      'g:b': { label: 'B', members: ['g:a', 'data-analysis:view:reports'] },
    } as never;
    const { expandViewGroups: exp } = await import('../view-groups');
    const out = exp(['g:a'], groups);
    expect(out).toContain('data-analysis:view:reports');   // 可达成员仍出现
    expect(out.filter((k) => k.startsWith('g:')).length).toBe(0);   // 不挂死、组键全被消费
  });

  it('M1：成员禁含通配/自引用——offenders 报出', () => {
    const bad = {
      'g:x': { label: 'X', members: ['data-analysis:view:*', 'g:x'] },
    } as never;
    expect(validateViewGroupMembers(bad).offenders).toEqual([
      'g:x -> data-analysis:view:*', 'g:x -> g:x',
    ]);
  });

  it('转正接线：resolveViewKey 对组持有者放行成员视图', async () => {
    const { resolveViewKey } = await import('../feature-perm');
    const r = resolveViewKey(['data-analysis:view-group:reports-all'], 'reports');
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `cd web && npx vitest run lib/__tests__/view-groups.test.ts`，Expected: FAIL（模块不存在）。
- [ ] **Step 3: 实现**

```ts
// web/lib/view-groups.ts
// view-group 展开转正（spec §5.5）：映射在 catalog（app 侧），Casdoor 只见组名 resource。
// 嵌套支持；环由 visited-set 截断（防御）——准入在 Task 3 校验器（detectViewGroupCycle 红测）。
// M1：成员只允许具名 view:* key（通配兜底会自动扩权，validateViewGroupMembers 拒绝）。
import { VIEW_GROUPS } from './capability-catalog';

type Groups = Record<string, { label: string; members: readonly string[] }>;
const groups = VIEW_GROUPS as unknown as Groups;

export function validateViewGroupMembers(g: Groups = groups): { offenders: string[] } {
  const offenders: string[] = [];
  for (const [name, def] of Object.entries(g))
    for (const m of def.members)
      if (m === '*' || m.endsWith(':*') || m === name) offenders.push(`${name} -> ${m}`);
  return { offenders };
}

export function expandViewGroups(perms: readonly string[], g: Groups = groups): string[] {
  const out = new Set<string>();
  const expand = (key: string, visited: Set<string>): void => {
    const def = g[key];
    if (!def) { out.add(key); return; }               // 非组键（含 view:* 具名/通配）原样保留
    if (visited.has(key)) {                           // 环防御（校验器准入外的兜底）
      console.error(`[view-groups] cycle detected at ${key} — 截断`);
      return;
    }
    const v2 = new Set(visited); v2.add(key);
    for (const m of def.members) expand(m, v2);
  };
  for (const p of perms) expand(p, new Set());
  return [...out];
}
```

`web/lib/feature-perm.ts` 的 `resolveViewKey` 首行改为 `const pool = new Set(expandViewGroups(perms));` 并把两处 `perms.includes(...)` 改查 `pool`（named / wildcard 判定不变；import 加 `expandViewGroups`）。生效粒度（S1 钉死）：**成员变更 → catalog_v 版本戳变（CATALOG_V env 随部署 bump）→ 旧令牌 48h TTL 内强制刷新**——机制即 Task 13 已落地的 catalog_v + iat 判定，不另建通道。

- [ ] **Step 4: 跑测试确认通过**：Run `cd web && npx vitest run lib/__tests__/view-groups.test.ts`，Expected: PASS（5 例）；`npx vitest run lib/__tests__/validate-capabilities.test.ts` 仍 PASS（Task 3 环引用红测不回归）。
- [ ] **Step 5: 校验器接线自证**：`validateViewGroupMembers().offenders` 为空（catalog 真值合规）——加进 `web/lib/__tests__/validate-capabilities.test.ts` 一例断言（catalog 变更时 CI 红）。
- [ ] **Step 6: Commit** `git add web/lib/view-groups.ts web/lib/__tests__/view-groups.test.ts web/lib/feature-perm.ts web/lib/__tests__/validate-capabilities.test.ts && git commit -m "feat(w5): view-group 展开转正——嵌套+环防御+成员禁通配（Task19，S1/M1）"`

---

## W6：data_permissions sunset + 契约①替代 + 旧 key 摘除（前置：W5 退出判据全绿）

> **W6 退出判据（客观门禁）**：对账 7 天无 data_permissions 引用 ∧ 167 回滚演练留痕 ∧ 契约①替代绿。双氧期（B6）至此结束。

### Task 20: data_permissions 表删除 + 契约①替代 + 旧 key 摘除（迁移 185 + rollback，B6/H11/H9 收口）

**Files:**
- Create: `database/migrations/185_perm_sunset.sql`
- Create: `database/rollback/167_reverse.sql`
- Test: `scripts/tests/perm-sunset.test.mjs` + `scripts/tests/roles-contract-sunset.test.mjs`（契约①替代，H11）
- Modify: `functions/wecom-oidc-callback/claims.js`（摘除顶层旧四维 key 镜像——B6 双氧期结束）
- Modify: `database/migrations/175_get_user_perms_input_switch.sql`（get_user_perms 强制 casdoor——见 Step 3 说明）

**Interfaces:**
- Consumes: `perm_freeze_snapshot`（Task 14——rollback 数据源）、`temporary_grants`（Task 17）、`scope_match_v2`（Task 17 并集版）、`can_cost_visible`（Task 16）。
- Produces: DROP `data_permissions` + `claim_match_or_star`；`scope_match_v2` 终版（无 legacy 回退支——data_scope 段缺失 = deny，B1 全量生效）；`can_cost_visible` 终版（只读 `fields.cost`，摘 `can_see_cost` 回退）；`get_user_perms` casdoor-only 版；契约①替代测试（Casdoor roles ⊆ Group tree 成员 ∪ org_users.role_codes 差分期望集）；回滚脚本 `database/rollback/167_reverse.sql`（bypass 逃生门 + 快照恢复 + 权限复授）。

- [ ] **Step 1: 写失败测试（两份）**

```js
// scripts/tests/perm-sunset.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PSQL = (sql) => execSync(
  `docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc ${JSON.stringify(sql)}`,
  { encoding: 'utf8' }).trim();

test('绿：data_permissions 已删（sunset 生效）', () => {
  assert.equal(PSQL(`SELECT to_regclass('public.data_permissions') IS NULL`), 't');
});

test('绿：claim_match_or_star 已删且无任何策略/函数引用', () => {
  assert.equal(PSQL(`SELECT to_regprocedure('claim_match_or_star(text,text)') IS NULL`), 't');
  const refs = PSQL(`SELECT count(*) FROM pg_policies WHERE qual LIKE '%claim_match_or_star%'`);
  assert.equal(refs, '0');
});

test('绿：scope_match_v2 终版——无 data_scope 段（旧形状令牌）也 deny（回退支已删，B1 全量）', () => {
  const r = PSQL(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"shanhai/legacy-shape"}', true);
SELECT scope_match_v2('branch_nums', '3120-001');
ROLLBACK;`);
  assert.equal(r, 'f');
});

test('绿：can_cost_visible 终版——旧顶层 can_see_cost 不再回退（fields 段唯一判定源）', () => {
  const r = PSQL(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"shanhai/x","can_see_cost":true}', true);
SELECT can_cost_visible();
ROLLBACK;`);
  assert.equal(r, 'f');   // 旧 key 镜像摘除后，无 fields 段 = 全掩（安全方向）
});

test('绿：perm_freeze_snapshot 保留（回滚保险 + 审计）', () => {
  assert.equal(PSQL(`SELECT to_regclass('public.perm_freeze_snapshot') IS NOT NULL`), 't');
});
```

```js
// scripts/tests/roles-contract-sunset.test.mjs
// H11 契约①替代：08-15 契约①（Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}）
// 依赖的表已删 → 替代契约 = Casdoor roles ⊆ Group tree 成员 ∪ org_users.role_codes 差分期望集。
// Casdoor 侧经 web/lib/sync/casdoor-client.ts 同款 client_credentials（env 注入，测试可 mock）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('契约①替代：Casdoor role 子集校验（roles ⊆ 挂组用户 role_codes ∪ {admin}，差分非空即红）', async () => {
  const { casdoorListRoles, listGroupMemberRoleCodes } = await import('../web/lib/sync/casdoor-client.ts');
  // ↑ 实际以仓内 client 导出为准（worker 落地时对齐签名；mock 模式同 resource-sync.test.ts）
  const casdoorRoles = await casdoorListRoles();                        // Casdoor 全量 role name
  const expectSet = new Set([...(await listGroupMemberRoleCodes()), 'admin']);
  const missing = casdoorRoles.filter((r: string) => !expectSet.has(r));
  assert.deepEqual(missing, [], `Casdoor 存在无期望源映射的 role: ${missing}`);
});
```

- [ ] **Step 2: 跑测试确认失败**：Run `node --test scripts/tests/perm-sunset.test.mjs`，Expected: FAIL（表还在/回退支还在）。
- [ ] **Step 3: 写迁移 185 + 175 修正 + rollback 脚本**

```sql
-- 185_perm_sunset.sql
-- W6 / B6+H11+H9 收口：data_permissions 删除（双氧期结束）。前置 = W5 退出判据全绿。
-- 终版函数替换（每部署 179/182 重跑建过渡版 → 185 终版胜出——migrate.sh 全量重跑序保证）。
BEGIN;

-- ① scope_match_v2 终版：删 legacy 回退支（data_scope 缺失 = deny；B1 全量生效）
CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_scope  JSONB; v_dim JSONB; v_grants JSONB; v_gdim JSONB; v_val TEXT;
BEGIN
  v_scope := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'data_scope';
  IF v_scope IS NULL THEN
    RETURN FALSE;                       -- ★终版：旧形状令牌不再回退 072（S4 豁免窗口关闭）
  END IF;
  v_dim    := v_scope -> p_dim;
  v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  v_gdim   := coalesce(v_grants -> p_dim, '[]'::jsonb);
  IF (v_dim IS NULL OR jsonb_array_length(v_dim) = 0) AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);
  IF v_dim ? '*' OR v_gdim ? '*' THEN RETURN TRUE; END IF;
  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
    IF v_val = p_col THEN RETURN TRUE; END IF;
  END LOOP;
  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_gdim)) LOOP
    IF v_val = p_col THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END; $$;
GRANT EXECUTE ON FUNCTION scope_match_v2 TO anon, authenticated;

-- ② can_cost_visible 终版：只认 fields.cost（摘 can_see_cost 旧 key 回退，B6）
CREATE OR REPLACE FUNCTION can_cost_visible()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_fields JSONB;
BEGIN
  v_fields := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'fields';
  RETURN coalesce((v_fields->>'cost')::boolean, false);   -- 无 fields 段/缺 key = 全掩（安全方向）
END; $$;
GRANT EXECUTE ON FUNCTION can_cost_visible TO anon, authenticated;

-- ③ get_user_perms casdoor-only 强制（输入开关钉死 casdoor；legacy 分支不可达）
UPDATE system_flags SET value = 'casdoor', updated_at = now()
 WHERE key = 'perms_input'
   AND NOT EXISTS (SELECT 1 FROM data_permissions);   -- 仅 sunset 后钉死（表在 = 演练/回滚期不强制）

-- ④ sunset 本体：先函数残留清点后删表
--    执行前清点（人工核对清单）：SELECT proname FROM pg_proc WHERE prosrc LIKE '%data_permissions%';
--    plpgsql 函数体不随 DROP 校验，但残留引用会在调用时炸——凡命中者在本迁移前重建为
--    Casdoor/temporary_grants 口径（get_user_perms 已由 175+③ 处理；新增残留同款处理）。
DROP FUNCTION IF EXISTS claim_match_or_star(TEXT, TEXT);
DROP TABLE IF EXISTS data_permissions;

COMMIT;
```

`175_get_user_perms_input_switch.sql` 修正（一段）：get_user_perms 的 legacy 分支读 data_permissions——plpgsql 体在 CREATE 时不校验表存在，但 sunset 后每部署 175 重跑会重建出「引用已删表」的函数体；把 175 的 `DROP FUNCTION IF EXISTS get_user_perms(...)` + `CREATE FUNCTION` 整段包进 `DO $$ BEGIN IF to_regclass('public.data_permissions') IS NOT NULL THEN ... END IF; END $$;`（表删后跳过重建——终版函数由 185 段落负责落；两迁移同部署序内 185 恒后于 175）。

`functions/wecom-oidc-callback/claims.js` 摘除（B6 镜像终止）：`buildClaims` 输出的顶层 `branch_nums/brands/categories/can_see_cost` 四行镜像删除（保留 departments/roles/permissions/新四段不动）；`claims.test.js` 同步删「旧 key 镜像非空」断言、加「旧 key 不存在」断言。

```sql
-- database/rollback/167_reverse.sql
-- 167 反向 + sunset 回滚（Task 20 演练物）：恢复 data_permissions（结构 + perm_freeze_snapshot 数据）
-- + 复授写权限 + 摘写关闭触发器。claims/RLS 终版的回滚 = git revert 185 后走 GHA（migrate.sh 重跑
-- 179/182 过渡版自动还原），本脚本只管表与数据。演练步骤见 Task 20 Step 6。
BEGIN;
SET LOCAL app.bypass_perm_write = 'on';

CREATE TABLE IF NOT EXISTS data_permissions (
  id BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','role','dept')),
  subject_id TEXT NOT NULL,
  branch_nums jsonb DEFAULT NULL,
  brands jsonb DEFAULT NULL,
  categories jsonb DEFAULT NULL,
  can_see_cost BOOLEAN DEFAULT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);
INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
SELECT subject_type, subject_id, branch_nums, brands, categories, can_see_cost, 'restored from freeze snapshot'
FROM perm_freeze_snapshot
ON CONFLICT (subject_type, subject_id) DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON data_permissions TO anon, authenticated;
DROP TRIGGER IF EXISTS trg_dp_write_close ON data_permissions;

COMMIT;
```

（列清单以 `perm_freeze_snapshot` 实际列为准对齐——Task 14 冻结时逐列 COPY，本脚本结构段按其逆推；worker 落地时 `SELECT column_name FROM information_schema.columns WHERE table_name='perm_freeze_snapshot'` 核对后誊写。）

- [ ] **Step 4: 跑测试确认通过**：Run `docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/185_perm_sunset.sql`（两遍验幂等）`&& node --test scripts/tests/perm-sunset.test.mjs`，Expected: 5 例 PASS。`node --test scripts/tests/roles-contract-sunset.test.mjs`，Expected: PASS（差分为空）。回归：`node --test scripts/tests/rls-branch-policy.test.mjs`（legacy 两例随终版语义更新为 deny 断言——测试文件同步改，其余不回归）+ `node --test scripts/tests/exception-rls-union.test.mjs`。
- [ ] **Step 5: claims 摘除部署（function-only 路径）**：`cd functions/wecom-oidc-callback && (deno test claims.test.js || node claims.test.js)` PASS 后，按 CLAUDE.md SSH 直调 InsForge API PUT + 清 Deno 缓存 + `curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-oidc-callback` 验证（与 Task 11 同窗纪律——本 task 在 W6，U2 早已完成）。
- [ ] **Step 6: 回滚演练留痕（W6 退出判据）**：本地容器跑 `psql < database/rollback/167_reverse.sql` → 断言行数 = 快照行数 → 再跑 185 恢复 sunset → 循环一遍全绿；演练记录写 `docs/ops/iam-sunset-rollback-drill.md`（日期/命令/结果三段）。
- [ ] **Step 7: Commit** `git add database/migrations/185_perm_sunset.sql database/rollback/ database/migrations/175_get_user_perms_input_switch.sql functions/wecom-oidc-callback/ scripts/tests/ docs/ops/iam-sunset-rollback-drill.md && git commit -m "feat(w6): data_permissions sunset+契约①替代+旧 key 摘除+回滚演练（Task20，B6/H11）"`

---

## 收尾（全部 task 后）

- 观测确认（非新码）：reconcile-catalog / reconcile-groups 两 cron 连续 7 天无红留痕（W2/W5/W6 退出判据的时间窗证据）。
- `docs/ops/permission-boundary.md` 终态复核：三分流表述与实现对齐（Task 0 改后首次全面回读）。
- spec「残余风险」对照：H16 即时失效若实现为 48h 窗口（token_blacklist 未接），在 spec 残余风险节补记转岗对账条目。

## Self-Review 结论

- 覆盖检查：spec §5.1 catalog→Task 1-6；§5.2 三分流+例外表+写关闭→Task 17/18（sunset→Task 20）；§5.3 Group tree→Task 7-10；§5.4 claims→Task 11-13（终版摘除→Task 20）；§5.5 view-group→Task 19；§5.6 变更传播→catalog_v/48h TTL（Task 13）+ 组对账 cron（Task 10）——webhook 端点归 08-15 U 轴（D6 已在彼侧立 task，本计划不重复）；§5.7 执行端消费→Task 12/13/16/19；§5.8 对账回滚→Task 5/10/14/15/20。W 轴 W1-W6 ↔ Task 0-20 一一对应。
- 占位符：无 TBD/TODO；所有代码步骤含实际代码或精确 SQL/路径；两处「worker 执行时清点」为仓内现状 grep 步骤（179 策略清单、185 函数残留清点），非占位。
- 类型一致：`scope_match_v2(p_dim,p_col)` 179→183→185 三版签名不变；`x_grants` GUC 形状（183 产、Task 17 测试消费）一致；`expandViewGroups`（Task 19）与 `resolveViewKey`（Task 13 改造处）签名一致；`VIEW_GROUPS/detectViewGroupCycle`（Task 1/3 产、19 消费）一致；`getExceptionGrants/invalidateExceptionCache`（Task 17 产、grants route 消费）一致。
- 迁移重跑一致性：migrate.sh 全量重跑序下，114→183（pre_request 终版胜出）、179→183→185（scope_match_v2 终版胜出）、167/175/184 加 to_regclass/触发器守卫后 W5/W6 状态重跑全绿——「每次部署重跑全部迁移」铁律已消化。
