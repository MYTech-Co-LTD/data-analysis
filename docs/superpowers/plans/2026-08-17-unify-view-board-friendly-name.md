# 统一视图/看板能力点 + 全量通俗名（方案 C）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一视图级（`view:*`）与看板级（`view-board:*`）能力点为单一语义（报表授权 ⇒ 视图访问），退役 11 个零消费死 key，并让 Casdoor 权限页 `permission.resources` 全量显示通俗名（人读名称）。

**Architecture:** 「单真相 + 边界归一」。通俗名唯一真相 = `capability-catalog.ts` 的 `label`（看板/KPI 用 `capability-board.ts` 的 `name`）。Casdoor `resource.name` 与 `permission.resources` 写入通俗名；消费侧（claims.js / feature-perm / reconcile / resource-sync）在边界用 `FRIENDLY_TO_KEY`/`BY_NAME` 反查还原成 key 后继续按 key 判定。JWT 内部恒为 key。退役 key 走既有 `DEPRECATED` 通道（H14）+ 生产 permission 迁移清理。

**Tech Stack:** TypeScript (web/lib), CJS (functions/wecom-oidc-callback), Vitest (web), 手写 assert (claims.test.js), Casdoor REST API (add-resource / update-permission / get-all-objects), GHA (CATALOG_V 自动 hash)。

**Spec:** `docs/superpowers/specs/2026-08-16-platform-iam-standardization-design.md`（§5.1 catalog、§5.5 view-group、H12/H14）；`docs/ops/casdoor-role-permission-mechanism.md`（update-permission AllCols 教训）；`docs/ops/permission-maintenance.md`（角色权限维护）。

## Global Constraints

- **update-permission 必须带完整字段**（name/owner/users/groups/roles/resources/actions/effect/isEnabled），否则 `.AllCols().Update()` 清空其余字段（Casdoor `object/permission.go:175` 教训，commit `186a5ab` 踩过）。
- **通俗名必须全局唯一**（Casdoor resource.name 是主键 + BY_NAME 反查不可歧义）。catalog 加载时断言。
- **catalog key 不得含 `_`**（scan 纪律）；`:` 在 Casdoor 禁字符 `/?:#&%=+;` 内，映射 `:`→`_`。
- **JWT claims.permissions 恒为 key**（claims.js `normReach` 在边界归一）；前端/middleware 永远看到 key。
- **DEPRECATED 与 CATALOG 不相交**；废弃 key 仍被 permission 引用 = `E-deprecated-key` 红（对账）。
- **`view-group` 成员必须 ∈ CATALOG 且禁通配**（测试钉死）。
- **H12 单真相**：`capabilityCatalog` 只存在于 `web/lib/capability-catalog.ts` 单副本；claims.js 只消费不复制（用静态镜像 + 测试断言防漂移）。
- 提交前必须：`bash scripts/check-functions.sh && cd web && npm run lint && npx tsc --noEmit`。
- 每个任务结尾 `git commit`（pre-commit hook 自动跑 lint-staged + check-functions.sh）。

---

## 现状证据（真机取证 2026-08-17）

**生产 5 个 role-\* permission 的 resources（22 项，manager/buyer 无 `field:cost`）：**
```
data-analysis:view:mobile                          ← 退役
data-analysis:view:report_brand_metric_gen         ← 退役（看板 brand 覆盖）
data-analysis:view:report_category_summary_gen     ← 退役（看板 category 覆盖）
data-analysis:view:report_item_breakdown_gen       ← 退役（看板 item-top 覆盖）
data-analysis:view:report_region_breakdown_gen     ← 退役（看板 region 覆盖）
data-analysis:view:report_supply_chain_outbound_gen← 退役（看板 supply-chain 覆盖）
data-analysis:view:report_wholesale_customer_gen   ← 退役（看板 wholesale 覆盖）
data-analysis:view:report_wholesale_daily_customer_gen ← 退役（看板 wholesale 覆盖）
data-analysis:view:report_wholesale_daily_gen      ← 退役（看板 wholesale 覆盖）
data-analysis:view:reports                         ← 保留（页面级，middleware 消费）→ 通俗名 经营总览
data-analysis:view:reports-items                   ← 退役
data-analysis:view:reports-targets                 ← 保留（页面级，middleware 消费）→ 通俗名 目标达成
data-analysis:view:wholesale-customers             ← 退役
data-analysis:view-group:reports-all               ← 保留 → 通俗名 报表看板全组
data-analysis:brand:3120                           ← 保留 → 通俗名 熊喵鲜生
data-analysis:brand:64188                          ← 保留 → 通俗名 品品甜
data-analysis:category:水果                        ← 保留 → 通俗名 水果
data-analysis:category:标品                        ← 保留 → 通俗名 标品
data-analysis:category:耗材                        ← 保留 → 通俗名 耗材
data-analysis:field:cost                           ← 保留 → 通俗名 成本可见（manager/buyer 无）
data-analysis:view-board:*                         ← 保留（通配，无通俗名，恒为 key）
data-analysis:view-kpi:*                           ← 保留（通配，无通俗名，恒为 key）
```

**退役 11 个 key：**
| key | 原因 |
|---|---|
| `view:mobile` | 零消费（移动端页面无门禁） |
| 8× `view:report_*_gen`（含 `wholesale_customer_gen`） | 零消费（看板能力覆盖） |
| `view:reports-items` | 零消费（OVERRIDES 保护键，需从 OVERRIDES 摘除） |
| `view:wholesale-customers` | 零消费（OVERRIDES 保护键，需从 OVERRIDES 摘除） |

**保留 key（全部有通俗名，除通配）：**
| key | 通俗名（= catalog label） |
|---|---|
| `view:reports` | 经营总览 |
| `view:reports-targets` | 目标达成 |
| `view-group:reports-all` | 报表看板全组 |
| `brand:3120` | 熊喵鲜生 |
| `brand:64188` | 品品甜 |
| `category:水果` | 水果 |
| `category:标品` | 标品 |
| `category:耗材` | 耗材 |
| `field:cost` | 成本可见 |
| `view-board:*` | （通配，无） |
| `view-kpi:*` | （通配，无） |
| `admin` | 管理台（当前 5 个 role-* 未含，但保留） |

**看板覆盖视图映射（capability-board 单真相新增 `view` 字段）：**
```
view-board:brand → report_brand_metric_gen
view-board:category → report_category_summary_gen
view-board:item-top → report_item_breakdown_gen
view-board:region → report_region_breakdown_gen
view-board:supply-chain → report_supply_chain_outbound_gen
view-board:wholesale → [report_wholesale_customer_gen, report_wholesale_daily_customer_gen, report_wholesale_daily_gen]
view-board:kpi → （无底层报表视图）
```

---

## 文件结构

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/lib/capability-catalog.ts` | 单真相：OVERRIDES 摘 2 键、DEPRECATED 加 11 键、VIEW_GROUPS 摘 2 成员 | T1 |
| `web/lib/capability-catalog.generated.ts` | scan 产物（重跑 scan 自动更新） | T1 |
| `web/lib/capability-board.ts` | BoardCapability 加 `view?: string[]` 覆盖声明 + 覆盖反查表 | T2 |
| `web/lib/feature-perm.ts` | `buildPermPool` 全量归一 + `hasBoardPerm`/`hasKpiPerm` 支持通俗名 | T3 |
| `functions/wecom-oidc-callback/claims.js` | `FRIENDLY_TO_KEY` 全量（13→23 项）+ 覆盖视图注入 | T4 |
| `functions/wecom-oidc-callback/claims.test.js` | 断言 FRIENDLY_TO_KEY 与 catalog 同步 + 覆盖注入 | T4 |
| `functions/wecom-oidc-callback/index.bundle.js` | esbuild 产物（重跑 build） | T4 |
| `web/lib/sync/resource-sync.ts` | `displayName()` 全量用通俗名（catalog label） | T5 |
| `web/lib/reconcile-catalog.ts` | `normKey` 全量（catalog label 反查） | T5 |
| `scripts/reconcile-catalog.mjs` | `classifyDiff` 归一（读 catalog label 反查） | T5 |
| `web/lib/capability-catalog.test.ts` | 更新断言（DEPRECATED 11 键、VIEW_GROUPS 成员、通俗名唯一） | T1 |
| `web/lib/__tests__/view-groups.test.ts` | 更新成员断言 | T1 |
| `web/lib/__tests__/feature-perm.test.ts` | 新增通俗名/覆盖用例 | T3 |
| `web/lib/__tests__/reconcile-catalog.test.ts` | 新增通俗名归一用例 | T5 |
| `web/lib/sync/__tests__/resource-sync.test.ts` | 新增通俗名 displayName 用例 | T5 |
| `scripts/tests/reconcile-catalog.test.mjs` | 更新（如引用退役 key） | T5 |
| `docs/ops/permission-maintenance.md` | 更新维护文档（退役清单/通俗名表） | T6 |
| `docs/ops/casdoor-role-permission-mechanism.md` | 更新机制文档 | T6 |
| `scripts/migrate-perms-friendly.mjs` | 生产迁移脚本（update-permission 全字段） | T6 |
| `docs/superpowers/plans/2026-08-17-unify-view-board-friendly-name.md` | 本计划 | — |

---

## Task 1: Catalog 单真相退役 11 键 + 通俗名唯一性

**Files:**
- Modify: `web/lib/capability-catalog.ts`
- Modify (auto): `web/lib/capability-catalog.generated.ts`（重跑 scan）
- Test: `web/lib/__tests__/capability-catalog.test.ts`
- Test: `web/lib/__tests__/view-groups.test.ts`

**Interfaces:**
- Consumes: `GENERATED_CATALOG`（scan 产物）、`BOARD_CAPABILITIES`/`KPI_CARD_CAPABILITIES`
- Produces: `capabilityCatalog`（退役后 23 项：2 generated + 8 MANUAL + 7 board + 6 KPI）、`CATALOG_KEYS`、`DEPRECATED_KEYS`（11 键）、`VIEW_GROUPS`（成员 2 项）、`LABEL_TO_KEY` / `KEY_TO_LABEL`（T2/T5 用）、通俗名唯一性断言

- [ ] **Step 1: 写失败测试**（先改测试钉死目标态）

`web/lib/__tests__/capability-catalog.test.ts` 追加：

```ts
it('退役 11 个零消费 view:* 死 key（方案 C 统一视图/看板）', () => {
  const retired = [
    'data-analysis:view:mobile',
    'data-analysis:view:report_brand_metric_gen',
    'data-analysis:view:report_category_summary_gen',
    'data-analysis:view:report_item_breakdown_gen',
    'data-analysis:view:report_region_breakdown_gen',
    'data-analysis:view:report_supply_chain_outbound_gen',
    'data-analysis:view:report_wholesale_customer_gen',
    'data-analysis:view:report_wholesale_daily_customer_gen',
    'data-analysis:view:report_wholesale_daily_gen',
    'data-analysis:view:reports-items',
    'data-analysis:view:wholesale-customers',
  ];
  for (const k of retired) {
    expect(CATALOG_KEYS.has(k), `${k} 未退役`).toBe(false);
    expect(DEPRECATED_KEYS.has(k), `${k} 未进 DEPRECATED`).toBe(true);
  }
});

it('保留页面级 view 门禁（middleware 消费）+ 全部具名能力带通俗名', () => {
  expect(CATALOG_KEYS.has('data-analysis:view:reports')).toBe(true);
  expect(CATALOG_KEYS.has('data-analysis:view:reports-targets')).toBe(true);
  // 保留的具名能力（非通配）label 不得为英文 slug
  for (const e of capabilityCatalog) {
    if (e.key.startsWith('data-analysis:view:') && !e.key.endsWith(':*')) {
      expect(/[\u4e00-\u9fff]/.test(e.label), `${e.key} label 非中文通俗名: ${e.label}`).toBe(true);
    }
  }
});

it('VIEW_GROUPS 成员已收敛（退役成员摘除）', () => {
  const members = Object.values(VIEW_GROUPS).flatMap((g) => g.members);
  expect(members).toContain('data-analysis:view:reports');
  expect(members).toContain('data-analysis:view:reports-targets');
  expect(members).not.toContain('data-analysis:view:reports-items');
  expect(members).not.toContain('data-analysis:view:wholesale-customers');
  for (const m of members) expect(CATALOG_KEYS.has(m), `${m} 不在册`).toBe(true);
});

it('通俗名全局唯一（Casdoor resource name 主键 + BY_NAME 反查）', () => {
  const names = capabilityCatalog.filter((e) => e.label).map((e) => e.label);
  expect(new Set(names).size).toBe(names.length);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run __tests__/capability-catalog.test.ts`
Expected: FAIL（退役 key 仍在 CATALOG、VIEW_GROUPS 成员未收敛）

- [ ] **Step 3: 修改 `web/lib/capability-catalog.ts`**

3a. **OVERRIDES 摘除 2 键**（否则它们是保护键，scan 不放行移除）：

```ts
const OVERRIDES: Partial<Record<string, Partial<CatalogEntry>>> = {
  'data-analysis:view:reports':        { group: '看板', label: '经营总览' },
  // 'data-analysis:view:reports-items':  { group: '看板', label: '商品下钻' },  // 退役：零消费
  'data-analysis:view:reports-targets':{ group: '看板', label: '目标达成' },
  // 'data-analysis:view:wholesale-customers': { group: '看板', label: '批发客户下钻' },  // 退役：零消费
  'data-analysis:field:cost':          { group: '字段', label: '成本可见', sensitive: true },
};
```

3b. **VIEW_GROUPS 摘除 2 成员**：

```ts
export const VIEW_GROUPS = Object.freeze({
  'data-analysis:view-group:reports-all': {
    label: '报表看板全组',
    members: [
      'data-analysis:view:reports', 'data-analysis:view:reports-targets',
    ],
  },
} as const);
```

3c. **DEPRECATED 加 11 键**：

```ts
// 废弃清单（H14/redteam M2）：载体在 app 侧；驱逐判据 = 发布 ≥30 天 ∧ 审计无引用 ∧ 对账红区清零
// 2026-08-17 方案 C：退役 11 个零消费 view:* 死 key（统一视图/看板——报表授权由 view-board:* 覆盖）。
//   8 个 report_*_gen 由 scan 从 view-configs 自动发现 → 废弃清单过滤；
//   view:mobile 由 scan 从路由自动发现 → 废弃清单过滤；
//   view:reports-items / view:wholesale-customers 已从 OVERRIDES 摘除（不再保护）→ 废弃清单过滤。
const DEPRECATED: readonly string[] = [
  // 退役：报表视图 → 由看板能力覆盖（view-board:<id>）
  'data-analysis:view:report_brand_metric_gen',
  'data-analysis:view:report_category_summary_gen',
  'data-analysis:view:report_item_breakdown_gen',
  'data-analysis:view:report_region_breakdown_gen',
  'data-analysis:view:report_supply_chain_outbound_gen',
  'data-analysis:view:report_wholesale_customer_gen',
  'data-analysis:view:report_wholesale_daily_customer_gen',
  'data-analysis:view:report_wholesale_daily_gen',
  // 退役：零消费页面视图
  'data-analysis:view:mobile',
  'data-analysis:view:reports-items',
  'data-analysis:view:wholesale-customers',
];
```

> ⚠ `DEPRECATED` 有 11 项（退役清单 = `mobile` + 8×`report_*_gen` + `reports-items` + `wholesale-customers` = **11 个**；`view:reports-targets` **保留**——middleware 消费）。上面测试写 `DEPRECATED_KEYS.has(k)` 断言这 11 项全部为真。

等一下——确认退役数量：`report_brand_metric_gen, report_category_summary_gen, report_item_breakdown_gen, report_region_breakdown_gen, report_supply_chain_outbound_gen, report_wholesale_customer_gen, report_wholesale_daily_customer_gen, report_wholesale_daily_gen` = **8 个** report_*_gen（view-configs 正好 8 个），+ `mobile` + `reports-items` + `wholesale-customers` = **11 个**。生产 permission 里还有 9 个 report_*_gen？不——生产里是 `view:report_wholesale_customer_gen` + `view:report_wholesale_daily_customer_gen` + `view:report_wholesale_daily_gen` 是 3 个，加上 6 个其他 report_*_gen = 9 个？让我数 view-configs：brand/category/region/item/supply-chain/wholesale-customer/daily/daily-customer = 8 个。对，**8 个**。退役 = 8 + mobile + reports-items + wholesale-customers = **11 个**。测试和 DEPRECATED 都按 **11 个** 写。

3d. **加通俗名唯一性断言 + 派生映射表**（在 `merged`/`deduped` 之后）：

```ts
// 通俗名唯一性断言（方案 C 全量）：label = Casdoor resource.name（主键）+ BY_NAME 反查键，
// 重名 = 模块加载即抛错（复用 capability-board 的 2026-08-17 模式）。
{
  const seen = new Set<string>();
  for (const e of deduped) {
    if (!e.label) continue;
    if (seen.has(e.label)) {
      throw new Error(`[capability-catalog] 通俗名重复（破坏 Casdoor resource name 主键 + BY_NAME 反查）：${e.label}`);
    }
    seen.add(e.label);
  }
}

// 通俗名 ↔ key 双向映射（方案 C 全量归一查找表；看板/KPI 的 label 与 capability-board name 一致）
export const KEY_TO_LABEL: ReadonlyMap<string, string> = new Map(
  deduped.filter((e) => e.label).map((e) => [e.key, e.label]),
);
export const LABEL_TO_KEY: ReadonlyMap<string, string> = new Map(
  deduped.filter((e) => e.label).map((e) => [e.label, e.key]),
);
```

3e. **导出 `CATALOG_KEYS`/`DEPRECATED_KEYS`** 不变（已存在），补导出 `KEY_TO_LABEL`/`LABEL_TO_KEY`。

- [ ] **Step 4: 重跑 scan 更新 generated**

Run: `node scripts/scan-capabilities.mjs --write`
Expected: `[scan] generated 已重写（-11）`（11 个退役 key 从 generated 移除）
确认 `web/lib/capability-catalog.generated.ts` 不再含 11 个退役 key（`reports-targets` 仍在——它被 OVERRIDES 保护）。

> ⚠ 若 scan 报 `[scan] 新增` 或 `[scan] 移除` 数量与预期不符：先核对 `view:reports-targets` 是否仍受保护（它在 OVERRIDES 里），以及 11 个退役 key 是否都进了 DEPRECATED。

- [ ] **Step 5: 更新 `web/lib/__tests__/view-groups.test.ts`**

退役 `wholesale-customers` 从 group 成员摘除后，测试第一例引用它必须改：

```ts
it('组键展开为成员 view:* 键；非组键原样保留', () => {
  const out = expandViewGroups([
    'data-analysis:view-group:reports-all', 'data-analysis:admin',
  ]);
  expect(out).toContain('data-analysis:view:reports');
  expect(out).toContain('data-analysis:view:reports-targets');   // 改：reports-targets 替代 wholesale-customers
  expect(out).toContain('data-analysis:admin');
  expect(out).not.toContain('data-analysis:view-group:reports-all');   // 组键被展开消费
});
```

- [ ] **Step 6: 跑全量相关测试确认通过**

Run: `cd web && npx vitest run __tests__/capability-catalog.test.ts __tests__/view-groups.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add web/lib/capability-catalog.ts web/lib/capability-catalog.generated.ts \
  web/lib/__tests__/capability-catalog.test.ts web/lib/__tests__/view-groups.test.ts
git commit -m "feat(perm): 方案C退役11个零消费view:*死key，统一视图/看板（单真相catalog）"
```

---

## Task 2: capability-board 单真相加「覆盖报表视图」声明

**Files:**
- Modify: `web/lib/capability-board.ts`
- Test: `web/lib/__tests__/feature-perm.test.ts`（T3 会用到；本任务先加数据层）

**Interfaces:**
- Consumes: 现有 `BOARD_CAPABILITIES`
- Produces: `BoardCapability.view?: string[]`（该看板覆盖的底层报表视图名，不含 `data-analysis:view:` 前缀）、`BOARD_VIEW_COVERAGE: ReadonlyMap<string, string[]>`（boardId → view slugs）、覆盖视图唯一性断言

- [ ] **Step 1: 写失败测试**

`web/lib/__tests__/capability-board.test.ts`（若不存在则新建）：

```ts
import { describe, it, expect } from 'vitest';
import { BOARD_CAPABILITIES, BOARD_VIEW_COVERAGE, KPI_CARD_CAPABILITIES } from '../capability-board';

describe('capability-board 覆盖视图声明（方案 C 统一视图/看板）', () => {
  it('每个带底层报表的看板声明覆盖视图（覆盖视图 ∈ 退役清单对应）', () => {
    const coverage = BOARD_VIEW_COVERAGE;
    expect(coverage.get('brand')).toEqual(['report_brand_metric_gen']);
    expect(coverage.get('category')).toEqual(['report_category_summary_gen']);
    expect(coverage.get('item-top')).toEqual(['report_item_breakdown_gen']);
    expect(coverage.get('region')).toEqual(['report_region_breakdown_gen']);
    expect(coverage.get('supply-chain')).toEqual(['report_supply_chain_outbound_gen']);
    expect(coverage.get('wholesale')).toEqual([
      'report_wholesale_customer_gen', 'report_wholesale_daily_customer_gen', 'report_wholesale_daily_gen',
    ]);
  });
  it('覆盖视图不重复（一个 view 只被一个看板覆盖）', () => {
    const seen = new Set<string>();
    for (const views of BOARD_VIEW_COVERAGE.values()) {
      for (const v of views) {
        expect(seen.has(v), `view 被多看板覆盖: ${v}`).toBe(false);
        seen.add(v);
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run __tests__/capability-board.test.ts`
Expected: FAIL（`BOARD_VIEW_COVERAGE` 不存在）

- [ ] **Step 3: 修改 `web/lib/capability-board.ts`**

3a. `BoardCapability` 接口加字段：

```ts
export interface BoardCapability {
  /** 全局唯一能力 key（data-analysis:view-board:<id>） */
  key: string;
  /** 对应 BOARDS registry 的 board id（注册表主键） */
  id: string;
  /** 通俗命名（能力页展示） */
  name: string;
  /** 一句话描述（能力页展示，说明这看板是干什么的） */
  description: string;
  /** 方案 C：该看板覆盖的底层报表视图名（不含 data-analysis:view: 前缀）。
   *  报表授权由本看板能力覆盖 → 无需再单独配置 view:*（退役语义）。无底层报表的看板（kpi）省略。 */
  view?: readonly string[];
}
```

3b. 各 board 声明（在对应对象加 `view:` 字段）：

```ts
{
  key: 'data-analysis:view-board:brand',
  id: 'brand',
  name: '品牌×指标',
  description: '品牌维度指标下钻（熊喵鲜生/品品甜）',
  view: ['report_brand_metric_gen'],
},
{
  key: 'data-analysis:view-board:region',
  id: 'region',
  name: '门店战区',
  description: '战区/区域/门店三级下钻（数据按你的门店权限裁剪）',
  view: ['report_region_breakdown_gen'],
},
{
  key: 'data-analysis:view-board:item-top',
  id: 'item-top',
  name: '商品 TOP',
  description: '商品维度 TOP 排行（销售/出库日榜）',
  view: ['report_item_breakdown_gen'],
},
{
  key: 'data-analysis:view-board:category',
  id: 'category',
  name: '类别出库',
  description: '品类维度出库汇总（水果/标品/耗材）',
  view: ['report_category_summary_gen'],
},
{
  key: 'data-analysis:view-board:supply-chain',
  id: 'supply-chain',
  name: '供应链出库',
  description: '供应链出库明细（配送/批发双源）',
  view: ['report_supply_chain_outbound_gen'],
},
{
  key: 'data-analysis:view-board:wholesale',
  id: 'wholesale',
  name: '外部批发',
  description: '外部批发客户明细',
  view: ['report_wholesale_customer_gen', 'report_wholesale_daily_customer_gen', 'report_wholesale_daily_gen'],
},
```

3c. 派生覆盖表（在 `BOARD_CAPABILITY_BY_ID` 附近）：

```ts
/** 方案 C：boardId → 覆盖的底层报表视图 slugs（统一视图/看板——报表授权由看板能力覆盖） */
export const BOARD_VIEW_COVERAGE: ReadonlyMap<string, readonly string[]> = new Map(
  BOARD_CAPABILITIES
    .filter((b) => b.view && b.view.length > 0)
    .map((b) => [b.id, b.view!]),
);
```

3d. 覆盖视图唯一性断言（加在文件尾部通配断言块内或之后）：

```ts
// 覆盖视图唯一性（方案 C）：一个底层报表视图只被一个看板覆盖，否则「报表授权 ⇒ 视图」语义歧义
{
  const seen = new Set<string>();
  for (const views of BOARD_VIEW_COVERAGE.values()) {
    for (const v of views) {
      if (seen.has(v)) {
        throw new Error(`[capability-board] 报表视图被多看板覆盖（方案C覆盖语义歧义）：${v}`);
      }
      seen.add(v);
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run __tests__/capability-board.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/lib/capability-board.ts web/lib/__tests__/capability-board.test.ts
git commit -m "feat(perm): capability-board 声明看板覆盖报表视图（方案C统一视图/看板）"
```

---

## Task 3: feature-perm 全量通俗名归一 + 覆盖视图注入

**Files:**
- Modify: `web/lib/feature-perm.ts`
- Test: `web/lib/__tests__/feature-perm.test.ts`

**Interfaces:**
- Consumes: `LABEL_TO_KEY`（T1）、`BOARD_VIEW_COVERAGE`（T2）、`BOARD_CAPABILITY_BY_NAME`/`KPI_CARD_CAPABILITY_BY_NAME`
- Produces: `buildPermPool`（全量：通俗名 → key + 覆盖视图注入）、`normalizePerms`（导出的纯函数，T4/T5 复用语义）

- [ ] **Step 1: 写失败测试**

`web/lib/__tests__/feature-perm.test.ts` 追加：

```ts
describe('buildPermPool 全量通俗名归一 + 覆盖视图注入（方案 C 统一视图/看板）', () => {
  it('通俗名 → key：具名能力（含 view:reports/brand/category/field/admin）', () => {
    const pool = buildPermPool(['经营总览', '目标达成', '熊喵鲜生', '水果', '成本可见', '管理台']);
    expect(pool.has('data-analysis:view:reports')).toBe(true);
    expect(pool.has('data-analysis:view:reports-targets')).toBe(true);
    expect(pool.has('data-analysis:brand:3120')).toBe(true);
    expect(pool.has('data-analysis:category:水果')).toBe(true);
    expect(pool.has('data-analysis:field:cost')).toBe(true);
    expect(pool.has('data-analysis:admin')).toBe(true);
  });

  it('看板能力通俗名 → 覆盖的报表视图 key 注入（报表授权 ⇒ 视图访问）', () => {
    const pool = buildPermPool(['品牌×指标', '外部批发']);
    expect(pool.has('data-analysis:view-board:brand')).toBe(true);
    expect(pool.has('data-analysis:view:report_brand_metric_gen')).toBe(true);   // 覆盖注入
    expect(pool.has('data-analysis:view-board:wholesale')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_customer_gen')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_daily_gen')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_daily_customer_gen')).toBe(true);
  });

  it('覆盖注入幂等：同 key 不重复', () => {
    const pool = buildPermPool(['品牌×指标', 'data-analysis:view:report_brand_metric_gen']);
    expect([...pool].filter((k) => k === 'data-analysis:view:report_brand_metric_gen').length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run __tests__/feature-perm.test.ts`
Expected: FAIL（buildPermPool 只认 board/KPI，不认识 经营总览/熊喵鲜生，也不注入覆盖视图）

- [ ] **Step 3: 修改 `web/lib/feature-perm.ts`**

3a. import 增加 `LABEL_TO_KEY`（T1）、`BOARD_VIEW_COVERAGE`（T2）：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, LABEL_TO_KEY } from './capability-catalog';
import { expandViewGroups } from './view-groups';
import {
  BOARD_CAPABILITY_BY_KEY,
  BOARD_CAPABILITY_BY_NAME,
  KPI_CARD_CAPABILITY_BY_KEY,
  KPI_CARD_CAPABILITY_BY_NAME,
  BOARD_VIEW_COVERAGE,
} from './capability-board';
```

3b. 重写 `buildPermPool`（全量归一 + 覆盖注入）：

```ts
/**
 * 判定池：把 perms 中的通俗名还原为能力 key（方案甲：Casdoor 下拉选中通俗名写进 permission.resources
 *  后，claims/前端收到的权限串里可能直接是通俗名——判定前统一归一回 key）。
 * 方案 C 扩展：① 全量通俗名（catalog LABEL_TO_KEY，覆盖 view:*/brand:*/category:*/field/admin/view-group
 *  + 看板/KPI——catalog 已含 board/KPI 条目的 label）；② 看板能力 → 覆盖的底层报表视图 key 注入
 *  （报表授权 ⇒ 视图访问，BOARD_VIEW_COVERAGE）。
 * 实现顺序：反查（通俗名→key）→ 组展开 → 看板覆盖注入。
 */
export function buildPermPool(perms: readonly string[] | undefined): Set<string> {
  const src = perms ?? [];
  // 1) 通俗名 → key 全量反查（含组通俗名「报表看板全组」→ 组 key；看板通俗名 → view-board:<id>）
  const keys = src.map((p) => LABEL_TO_KEY.get(p) ?? p);
  // 2) view-group 展开（组 key → 成员 view:* key）；已具名/未知名原样保留
  const pool = new Set(expandViewGroups(keys));
  // 3) 看板授权 ⇒ 覆盖报表视图授权（BOARD_CAPABILITY_BY_KEY：从归一后 key 找看板定义）
  for (const k of keys) {
    const b = BOARD_CAPABILITY_BY_KEY.get(k);
    if (b) for (const v of BOARD_VIEW_COVERAGE.get(b.id) ?? []) pool.add(`data-analysis:view:${v}`);
  }
  return pool;
}
```

> 注意：`LABEL_TO_KEY` 已含看板/KPI 通俗名（catalog 第 38-42 行 `label: b.name`）→ `keys` 里看板通俗名已归一回 `view-board:<id>`，故第 3 步用 `BOARD_CAPABILITY_BY_KEY`（而非 BY_NAME）从 key 反查看板定义取覆盖。`expandViewGroups` 对非组 key 原样保留；`view-group:reports-all` 的通俗名「报表看板全组」反查成组 key 后由 expandViewGroups 展开成成员。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run __tests__/feature-perm.test.ts`
Expected: PASS（新增 3 例 + 既有全过）

- [ ] **Step 5: 提交**

```bash
git add web/lib/feature-perm.ts web/lib/__tests__/feature-perm.test.ts
git commit -m "feat(perm): buildPermPool 全量通俗名归一 + 看板覆盖报表视图注入"
```

---

## Task 4: claims.js FRIENDLY_TO_KEY 全量 + 覆盖视图注入

**Files:**
- Modify: `functions/wecom-oidc-callback/claims.js`
- Modify: `functions/wecom-oidc-callback/claims.test.js`
- Modify (auto): `functions/wecom-oidc-callback/index.bundle.js`（重跑 esbuild）

**Interfaces:**
- Consumes: `ctx.reachable`（get-all-objects 返回 permission.resources 原文——方案 C 后为通俗名+通配 key）
- Produces: `buildClaims`（JWT claims.permissions 恒为 key）、`FRIENDLY_TO_KEY`（全量 23 项）、`normalizeFriendlyPerm`

- [ ] **Step 1: 写失败测试**

`functions/wecom-oidc-callback/claims.test.js` 追加（`buildClaims` 测试区）：

```js
// ====== 方案 C：全量通俗名归一 + 看板覆盖报表视图（2026-08-17） ======
const friendlyCtx = { ...okCtx, reachable: [
  '经营总览', '目标达成', '熊喵鲜生', '品品甜', '水果', '标品', '耗材', '成本可见',
  '报表看板全组', '品牌×指标', '外部批发',
] };
const fc = buildClaims(friendlyCtx);
eq(fc.permissions.includes('data-analysis:view:reports'), true, '通俗名 经营总览 → key view:reports');
eq(fc.permissions.includes('data-analysis:view:reports-targets'), true, '通俗名 目标达成 → key view:reports-targets');
eq(fc.permissions.includes('data-analysis:brand:3120'), true, '通俗名 熊喵鲜生 → key brand:3120');
eq(fc.permissions.includes('data-analysis:category:水果'), true, '通俗名 水果 → key category:水果');
eq(fc.data_scope.brands.includes('3120'), true, '品牌通俗名 → data_scope.brands');
eq(fc.data_scope.categories.includes('水果'), true, '品类通俗名 → data_scope.categories');
eq(fc.fields.cost, true, '通俗名 成本可见 → fields.cost');
eq(fc.permissions.includes('data-analysis:view:report_brand_metric_gen'), true, '看板通俗名 品牌×指标 → 覆盖报表视图注入');
eq(fc.permissions.includes('data-analysis:view:report_wholesale_daily_gen'), true, '看板通俗名 外部批发 → 覆盖批发日表注入');
eq(fc.permissions.includes('data-analysis:view-board:brand'), true, '看板通俗名 → key view-board:brand');
// 组通俗名 → 组 key（claims 只反查不展开——组展开在 web 侧 buildPermPool / expandViewGroups）
eq(fc.permissions.includes('data-analysis:view-group:reports-all'), true, '组通俗名 报表看板全组 → key view-group:reports-all');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`
Expected: FAIL（FRIENDLY_TO_KEY 只有 13 项，经营总览/熊喵鲜生等未归一 → permissions 里是中文原文，断言失败）

- [ ] **Step 3: 修改 `functions/wecom-oidc-callback/claims.js`**

3a. `buildClaims` 中 `normReach` 后加**覆盖视图注入**（在 B2 过滤前，把看板通俗名展开的报表视图加进归一集）：

```js
  // 方案甲：通俗名 → 能力 key 归一（内置映射表见文件底部，与 capability-catalog.ts 单真相同步）
  const normReach = ctx.reachable.map((k) => FRIENDLY_TO_KEY[k] ?? k);

  // 方案 C：看板授权 ⇒ 覆盖报表视图授权（BOARD_VIEW_COVERAGE 静态镜像——与 capability-board.ts 同步）。
  //   命中看板能力 key（data-analysis:view-board:<id>）→ 注入其覆盖的底层报表视图 key。
  const withCoverage = new Set(normReach);
  for (const k of normReach) {
    const covered = BOARD_VIEW_COVERAGE[k];
    if (covered) for (const v of covered) withCoverage.add(`data-analysis:view:${v}`);
  }

  // --- permissions（B2）：资源串过滤（去重——get-all-objects 并集路径可能重复，claims 需唯一）---
  const permissions = [...new Set([...withCoverage].filter((k) =>
    k === '*' || k.startsWith('data-analysis:') || k.startsWith('push:')))];
```

> 注意：`BOARD_VIEW_COVERAGE` 以 **view-board 能力 key 为键**（`data-analysis:view-board:brand` → `['report_brand_metric_gen']`），不是 board id。FRIENDLY_TO_KEY 已经把通俗名「品牌×指标」→ `data-analysis:view-board:brand`，所以循环命中 `BOARD_VIEW_COVERAGE['data-analysis:view-board:brand']` 注入。同时在 3b 里定义这个静态镜像表。

3b. 扩展 `FRIENDLY_TO_KEY`（13 → 23 项）并新增 `BOARD_VIEW_COVERAGE` 静态镜像（文件底部）：

```js
// 通俗名 → 能力 key 内置映射（方案甲 2026-08-17 + 方案 C 2026-08-17 全量）。
// 与 web/lib/capability-catalog.ts 单真相同步：全部具名能力（view:/brand:/category:/field/admin/view-group/看板/KPI）。
// ⚠ 保持同步：新增/改名能力必须同步这里 + capability-catalog.ts + claims.test.js 断言（防漂移）。
// ⚠ 禁改值语义：key 是 Casdoor permission.resources 的权威授权串，通俗名只是展示层别名。
const FRIENDLY_TO_KEY = {
  // 看板（7）
  '指标概览': 'data-analysis:view-board:kpi',
  '品牌×指标': 'data-analysis:view-board:brand',
  '门店战区': 'data-analysis:view-board:region',
  '商品 TOP': 'data-analysis:view-board:item-top',
  '类别出库': 'data-analysis:view-board:category',
  '供应链出库': 'data-analysis:view-board:supply-chain',
  '外部批发': 'data-analysis:view-board:wholesale',
  // KPI 卡（6）
  '门店零售': 'data-analysis:view-kpi:sale',
  '门店配送': 'data-analysis:view-kpi:delivery',
  '供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '毛利率': 'data-analysis:view-kpi:outbound_margin',
  // 页面级视图（2，middleware 消费）
  '经营总览': 'data-analysis:view:reports',
  '目标达成': 'data-analysis:view:reports-targets',
  // 品牌/品类/字段/门禁/授权组
  '熊喵鲜生': 'data-analysis:brand:3120',
  '品品甜': 'data-analysis:brand:64188',
  '水果': 'data-analysis:category:水果',
  '标品': 'data-analysis:category:标品',
  '耗材': 'data-analysis:category:耗材',
  '成本可见': 'data-analysis:field:cost',
  '管理台': 'data-analysis:admin',
  '报表看板全组': 'data-analysis:view-group:reports-all',
};

// 看板能力 key → 覆盖的底层报表视图 key（方案 C 静态镜像，与 capability-board.ts BOARD_VIEW_COVERAGE 同步）
const BOARD_VIEW_COVERAGE = {
  'data-analysis:view-board:brand': ['data-analysis:view:report_brand_metric_gen'],
  'data-analysis:view-board:category': ['data-analysis:view:report_category_summary_gen'],
  'data-analysis:view-board:item-top': ['data-analysis:view:report_item_breakdown_gen'],
  'data-analysis:view-board:region': ['data-analysis:view:report_region_breakdown_gen'],
  'data-analysis:view-board:supply-chain': ['data-analysis:view:report_supply_chain_outbound_gen'],
  'data-analysis:view-board:wholesale': [
    'data-analysis:view:report_wholesale_customer_gen',
    'data-analysis:view:report_wholesale_daily_customer_gen',
    'data-analysis:view:report_wholesale_daily_gen',
  ],
};
```

3c. `module.exports` 补导出 `BOARD_VIEW_COVERAGE`（供测试/断言）——**合并进第 82 行既有导出**（文件里有 54/82 两处 `module.exports`，82 行覆盖 54 行，是最新生效导出）：

```js
module.exports = { buildClaims, collapseFullStore, resolveGroupBranches, FRIENDLY_TO_KEY, normalizeFriendlyPerm, BOARD_VIEW_COVERAGE };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`
Expected: PASS（新增 11 例 + 既有全过）

- [ ] **Step 5: 重跑 esbuild 打包**

Run: `cd functions/wecom-oidc-callback && npx esbuild index.js --bundle --platform=node --format=cjs --outfile=index.bundle.js`（若项目有打包脚本则用 `npm run build`——查 `functions/wecom-oidc-callback/package.json`）
Expected: `index.bundle.js` 含新的 `FRIENDLY_TO_KEY`/`BOARD_VIEW_COVERAGE`

- [ ] **Step 6: 检查 function 语法**

Run: `bash scripts/check-functions.sh`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add functions/wecom-oidc-callback/claims.js functions/wecom-oidc-callback/claims.test.js \
  functions/wecom-oidc-callback/index.bundle.js
git commit -m "feat(perm): claims FRIENDLY_TO_KEY 全量通俗名归一 + 看板覆盖报表视图注入"
```

---

## Task 5: 消费侧全量归一（resource-sync / reconcile）

**Files:**
- Modify: `web/lib/sync/resource-sync.ts`
- Modify: `web/lib/reconcile-catalog.ts`
- Modify: `scripts/reconcile-catalog.mjs`
- Test: `web/lib/sync/__tests__/resource-sync.test.ts`
- Test: `web/lib/__tests__/reconcile-catalog.test.ts`
- Test: `scripts/tests/reconcile-catalog.test.mjs`

**Interfaces:**
- Consumes: `KEY_TO_LABEL`/`LABEL_TO_KEY`（T1）、`BOARD_VIEW_COVERAGE`（T2）
- Produces: `displayName(key)` 全量通俗名（resource-sync）、`normKey(r)` 全量反查（reconcile）

- [ ] **Step 1: 写失败测试**

`web/lib/sync/__tests__/resource-sync.test.ts` 追加：

```ts
it('displayName 全量用通俗名（方案 C）：view:reports→经营总览、brand→熊喵鲜生、category→水果', async () => {
  mockFetch.mockResolvedValueOnce(remoteHas([]));               // get-resources 空
  mockFetch.mockResolvedValueOnce(addOk);                       // add view:reports
  mockFetch.mockResolvedValueOnce(addOk);                       // add brand:3120
  mockFetch.mockResolvedValueOnce(addOk);                       // add category:水果
  const r = await syncResources('shanhai', [
    'data-analysis:view:reports', 'data-analysis:brand:3120', 'data-analysis:category:水果',
  ]);
  expect(r.added).toEqual(['data-analysis:view:reports', 'data-analysis:brand:3120', 'data-analysis:category:水果']);
  const calls = mockFetch.mock.calls.filter((c) => c[0] === '/api/add-resource');
  const names = calls.map((c) => JSON.parse(c[1].body).name);
  expect(names).toContain('经营总览');
  expect(names).toContain('熊喵鲜生');
  expect(names).toContain('水果');
  expect(names).not.toContain('data-analysis_view_reports');   // 不再用映射名
});
```

`web/lib/__tests__/reconcile-catalog.test.ts` 追加：

```ts
it('permission.resources 存通俗名 → 归一后识别（方案 C：view:reports→经营总览、brand→熊喵鲜生）', () => {
  const d = classifyCatalogReconcile({
    permissions: [{ name: 'p1', resources: ['经营总览', '熊喵鲜生', '水果'] }],
    catalog: CATALOG, deprecated: DEPRECATED,
  });
  expect(d.red.length).toBe(0);                                // 通俗名被归一，不报 E-unknown
  expect(d.minor.map((m) => m.key).sort()).toEqual(['data-analysis:admin', 'data-analysis:field:cost']);
});

it('退役 key 仍被 permission 引用 → E-deprecated-key 红（迁移未完即红）', () => {
  const d = classifyCatalogReconcile({
    permissions: [{ name: 'p1', resources: ['data-analysis:view:report_brand_metric_gen'] }],
    catalog: CATALOG, deprecated: new Set(['data-analysis:view:report_brand_metric_gen']),
  });
  expect(d.red.length).toBe(1);
  expect(d.red[0]).toMatchObject({ kind: 'E-deprecated-key', key: 'data-analysis:view:report_brand_metric_gen' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run __tests__/reconcile-catalog.test.ts sync/__tests__/resource-sync.test.ts`
Expected: FAIL（displayName 仍用映射名；normKey 只认 board/KPI）

- [ ] **Step 3: 修改 `web/lib/sync/resource-sync.ts`**

3a. import 加 `KEY_TO_LABEL`（T1）：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, KEY_TO_LABEL } from '../capability-catalog';
```

3b. 改 `displayName` 全量用通俗名：

```ts
// 通俗名 → Casdoor resource.name（方案甲 + 方案 C 全量）：有通俗名（catalog label / 看板-KPI name）
// 的能力用通俗名做展示名；无通俗名的（通配）退回映射名。
function displayName(key: string): string {
  return KEY_TO_LABEL.get(key) ?? enc(key);
}
```

> ⚠ 通配 key（`view-board:*`/`view-kpi:*`）不在 catalog 具名列表（无 label）→ 退回 `enc(key)` = `data-analysis_view-board_*`。但通配不注册为 resource（catalog 只含具名）——resource-sync 默认跑全 catalog，通配不在 catalog，所以不会被同步。无需特殊处理。

- [ ] **Step 4: 修改 `web/lib/reconcile-catalog.ts`**

4a. import 加 `LABEL_TO_KEY`（T1）：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, LABEL_TO_KEY } from './capability-catalog';
```

4b. `normKey` 全量反查：

```ts
  // 归一（方案甲 + 方案 C 全量）：Casdoor 下拉选中通俗名写进 permission.resources 时，先把通俗名还原成
  //   能力 key 再进 referenced（否则 E-unknown-key 误报 / M-unreferenced 漏报）。
  const normKey = (r: string): string =>
    BOARD_CAPABILITY_BY_NAME.get(r)?.key ?? KPI_CARD_CAPABILITY_BY_NAME.get(r)?.key ?? LABEL_TO_KEY.get(r) ?? r;
```

- [ ] **Step 5: 修改 `scripts/reconcile-catalog.mjs`**

5a. 读 catalog 后派生通俗名反查表（在 `catalogKeysFromSources` 里或之后）。`scripts/reconcile-catalog.mjs` 是纯 node 无 TS 依赖，需要从 `web/lib/capability-catalog.ts` 源码解析 label。参考 `scan-capabilities.mjs` 的解析模式，新增：

```js
// 方案 C：从 capability-catalog.ts 源码解析 通俗名(label) → key（H12 单真相，不复制定义）。
//   label 在 CatalogEntry 的 label: 'xxx' 字段；OVERRIDES 覆盖 label；MANUAL/board 也有 label。
//   归一用：permission.resources 存通俗名时反查回 key。
export function labelToKeyFromCatalog(catalogSrc) {
  const out = {};
  // 收集所有 label: 'x' 出现的 key（来自 entries + overrides 合并后）
  const rows = [...catalogSrc.matchAll(/key:\s*'([^']+)'[^}]*?label:\s*'([^']*)'/g)];
  for (const [, key, label] of rows) if (label) out[label] = key;
  // OVERRIDES 覆盖：{ 'data-analysis:view:reports': { ..., label: '经营总览' } }
  for (const m of catalogSrc.matchAll(/'([^']+)':\s*\{[^}]*?label:\s*'([^']+)'/g)) {
    if (m[1].startsWith('data-analysis:')) out[m[2]] = m[1];
  }
  return out;
}
```

> ⚠ 解析正则需与真实 `capability-catalog.ts` 形态匹配（MANUAL 是 `{ key: '...', group: '...', label: '...' }`，OVERRIDES 是 `'key': { group: '...', label: '...' }`，board/KPI 是 `...BOARD_CAPABILITIES.map((b) => ({ key: b.key, group: '看板', label: b.name, ... }))` —— 后者 label 是变量 `b.name` 不是字面量，正则抓不到）。**可靠方案**：直接在脚本里维护与 catalog 一致的通俗名映射表（脚本是 CLI 门禁，重跑 reconcile 时若 catalog 改动需人工同步——但 H12 禁复制）。更稳的做法：**脚本改为读 `capability-catalog.ts` 的 `LABEL_TO_KEY` 导出**（脚本已是 ESM，可 `await import('../../web/lib/capability-catalog.ts')`？不行——web/lib 是 TS）。折中：**脚本内维护静态镜像 + 测试断言**（与 claims.js 同模式，见 5b）。

5b. **折中方案**（采纳，与 claims.js 同模式）：`scripts/reconcile-catalog.mjs` 内加静态通俗名映射 + 归一，注释注明与 catalog 同步、由 `scripts/tests/reconcile-catalog.test.mjs` 断言：

```js
// 方案 C：通俗名 → key 静态镜像（与 web/lib/capability-catalog.ts LABEL_TO_KEY 同步，H12 例外：
//   CLI 门禁脚本无法 import TS 单真相 → 静态镜像 + 测试断言防漂移，同 claims.js 模式）。
// ⚠ 迁移后 permission.resources 会同时含 页面/品牌/品类/字段 通俗名 + 看板/KPI 通俗名——
//   本镜像须覆盖全部 23 项（页面/品牌/品类/字段/admin/view-group 10 项 + 看板 7 + KPI 6），
//   否则 classifyDiff 的 M-unreferenced 会对 view-board:*/view-kpi:* 误报（通俗名没归一成 key）。
const LABEL_TO_KEY = {
  // 页面/品牌/品类/字段/admin/view-group（10）
  '经营总览': 'data-analysis:view:reports',
  '目标达成': 'data-analysis:view:reports-targets',
  '报表看板全组': 'data-analysis:view-group:reports-all',
  '熊喵鲜生': 'data-analysis:brand:3120',
  '品品甜': 'data-analysis:brand:64188',
  '水果': 'data-analysis:category:水果',
  '标品': 'data-analysis:category:标品',
  '耗材': 'data-analysis:category:耗材',
  '成本可见': 'data-analysis:field:cost',
  '管理台': 'data-analysis:admin',
  // 看板（7，与 capability-board.ts name 同步）
  '指标概览': 'data-analysis:view-board:kpi',
  '品牌×指标': 'data-analysis:view-board:brand',
  '门店战区': 'data-analysis:view-board:region',
  '商品 TOP': 'data-analysis:view-board:item-top',
  '类别出库': 'data-analysis:view-board:category',
  '供应链出库': 'data-analysis:view-board:supply-chain',
  '外部批发': 'data-analysis:view-board:wholesale',
  // KPI 卡（6，与 capability-board.ts name 同步）
  '门店零售': 'data-analysis:view-kpi:sale',
  '门店配送': 'data-analysis:view-kpi:delivery',
  '供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '毛利率': 'data-analysis:view-kpi:outbound_margin',
};
const normKey = (r) => LABEL_TO_KEY[r] ?? r;
```

5c. 在 `classifyDiff` 的 permission 循环里用 `normKey` 归一（找 `for (const p of permissions)` 处，`r` 进 referenced 前）：

```js
  for (const p of permissions) {
    const rs = (p.resources ?? []).map((r) => String(r).replace(/^\//, ''));
    for (const r of rs) {
      const key = normKey(r);
      // ...（现有逻辑，用 key 而非 r）
    }
  }
```

> 若 `classifyDiff` 现有实现把原始 `r` 用于多处，需统一替换为归一后的 `key`。核对现有代码后调整。

- [ ] **Step 6: 更新 `scripts/tests/reconcile-catalog.test.mjs`**（如引用退役 key）

搜索该测试文件是否引用退役的 `view:report_*_gen`/`view:mobile`/`view:reports-items`/`view:wholesale-customers`，如有则替换为保留 key。运行：

Run: `node --test scripts/tests/reconcile-catalog.test.mjs`
Expected: PASS

- [ ] **Step 7: 跑全量 web 测试**

Run: `cd web && npx vitest run`
Expected: 全过

- [ ] **Step 8: 提交**

```bash
git add web/lib/sync/resource-sync.ts web/lib/reconcile-catalog.ts scripts/reconcile-catalog.mjs \
  web/lib/sync/__tests__/resource-sync.test.ts web/lib/__tests__/reconcile-catalog.test.ts \
  scripts/tests/reconcile-catalog.test.mjs
git commit -m "feat(perm): 消费侧全量通俗名归一（resource-sync displayName + reconcile normKey）"
```

---

## Task 6: 生产迁移（5 个 role-\* permission 改写通俗名 + 退役 key 清理）

**Files:**
- Create: `scripts/migrate-perms-friendly.mjs`
- Modify: `docs/ops/permission-maintenance.md`
- Modify: `docs/ops/casdoor-role-permission-mechanism.md`

**Interfaces:**
- Consumes: 生产 Casdoor API（client_credentials）、退役清单、通俗名表
- Produces: 5 个 role-\* permission.resources 更新为「保留 key 的通俗名 + 通配 key + 退役 key 删除」

- [ ] **Step 1: 写迁移脚本 `scripts/migrate-perms-friendly.mjs`**

```js
#!/usr/bin/env node
// scripts/migrate-perms-friendly.mjs —— 方案 C 生产迁移（2026-08-17）
// 目标：5 个 role-* permission.resources 从「原始 key + 11 个退役死 key」改写为
//   「保留具名能力的通俗名 + 通配 key（view-board:* / view-kpi:*）+ 退役 key 删除」。
// 结果：Casdoor 权限页显示通俗名（人读名称），get-all-objects 返回通俗名 → claims.js 反查 key。
//
// ⚠ update-permission 必须带完整字段（name/owner/users/groups/roles/resources/actions/effect/
//   isEnabled）——.AllCols().Update() 会清空未传字段（Casdoor object/permission.go:175 教训）。
//
// 用法（--live 才真调 Casdoor，默认 dry-run 打印 plan）：
//   node scripts/migrate-perms-friendly.mjs [--live]
import { readFileSync } from 'node:fs';

const CASDOOR_API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';

// 通俗名表（与 capability-catalog.ts 同步；T5 已定义，此处复用 import 或重复定义——脚本间不 import 防耦合）
const KEY_TO_LABEL = {
  'data-analysis:view:reports': '经营总览',
  'data-analysis:view:reports-targets': '目标达成',
  'data-analysis:view-group:reports-all': '报表看板全组',
  'data-analysis:brand:3120': '熊喵鲜生',
  'data-analysis:brand:64188': '品品甜',
  'data-analysis:category:水果': '水果',
  'data-analysis:category:标品': '标品',
  'data-analysis:category:耗材': '耗材',
  'data-analysis:field:cost': '成本可见',
  'data-analysis:admin': '管理台',
};

// 退役 11 个 key（从 permission.resources 删除）
const RETIRED = [
  'data-analysis:view:mobile',
  'data-analysis:view:report_brand_metric_gen',
  'data-analysis:view:report_category_summary_gen',
  'data-analysis:view:report_item_breakdown_gen',
  'data-analysis:view:report_region_breakdown_gen',
  'data-analysis:view:report_supply_chain_outbound_gen',
  'data-analysis:view:report_wholesale_customer_gen',
  'data-analysis:view:report_wholesale_daily_customer_gen',
  'data-analysis:view:report_wholesale_daily_gen',
  'data-analysis:view:reports-items',
  'data-analysis:view:wholesale-customers',
];

// 迁移：key → 通俗名（具名）；通配（view-board:* / view-kpi:*）保留原样；退役 key 删除
function migrateResources(resources) {
  const out = [];
  for (const r of resources) {
    if (RETIRED.includes(r)) continue;                        // 退役删除
    if (r.endsWith(':*') || r === '*') { out.push(r); continue; }  // 通配保留
    const label = KEY_TO_LABEL[r] ?? r;                       // 具名 → 通俗名（未知名兜底保留）
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

async function main() {
  const live = process.argv.includes('--live');
  // ...（client_credentials 获取 token，同 deploy/.env 注入模式）
  // ...（get-permissions → 过滤 role-* → migrateResources → update-permission 全字段）
  // ...（dry-run 打印 plan；--live 真调并打印 diff）
}

main().catch((e) => { console.error(e); process.exit(1); });
```

> 脚本完整实现需接通 token 获取 + get-permissions + update-permission。参考 `docs/ops/permission-maintenance.md` 的既有模式与 `web/lib/sync/casdoor-client.ts` 的 client_credentials 实现。**dry-run 必须能打印每个 permission 的 before/after resources diff**，`--live` 才写。

- [ ] **Step 2: 本地跑 dry-run 验证 plan**

Run: `cd /opt/data-analytics-platform/deploy && set -a && . ./.env && set +a && node /path/to/scripts/migrate-perms-friendly.mjs`
Expected: 打印 5 个 permission 的 before/after diff；after 含通俗名 + 通配，无退役 key

> 生产服务器无 node？AGENTS.md 说部署走 GHA；reconcile 在 web 镜像 node:22 内跑。迁移脚本可在本地（有 node）跑，SSH 到服务器取 token。或临时用 `docker exec deploy-web-1 node ...`（web 镜像有 node）。

- [ ] **Step 3: 真机执行迁移（--live）**

Run: `node scripts/migrate-perms-friendly.mjs --live`
Expected: 5 个 permission 全部更新成功；Casdoor 权限页显示通俗名

- [ ] **Step 4: 验证生产 get-all-objects + 登录 claims**

4a. 验证 `get-all-objects` 返回通俗名：

```bash
curl -s "https://sso.shanhaiyiguo.com/api/get-all-objects?userId=shanhai/ZhengXin&access_token=$TOKEN"
```
Expected: 返回含 经营总览、目标达成、熊喵鲜生、水果、view-board:*、view-kpi:* 等（通俗名 + 通配），无退役 key

4b. 验证真实登录 claims（企微客户端登录，或重新授权）：
Expected: `permissions` 数组为 key（claims.js 已归一），`data_scope.brands`/`categories` 正确提取

- [ ] **Step 5: 更新维护文档**

`docs/ops/permission-maintenance.md`：加「方案 C 统一视图/看板」小节，说明：
- 11 个退役 key 清单
- 看板覆盖视图语义（报表授权 ⇒ 视图访问）
- permission.resources 现在存通俗名（get-all-objects 返回通俗名 → claims 反查 key）
- 通配（view-board:* / view-kpi:*）恒为 key

`docs/ops/casdoor-role-permission-mechanism.md`：更新「permission.resources 存通俗名」说明。

- [ ] **Step 6: 提交**

```bash
git add scripts/migrate-perms-friendly.mjs docs/ops/permission-maintenance.md docs/ops/casdoor-role-permission-mechanism.md
git commit -m "feat(perm): 生产迁移脚本（role-* permission 通俗名 + 退役key清理）+ 维护文档"
```

---

## Task 7: 端到端验证 + 部署

**Files:**
- Modify: 无（验证/部署操作）

- [ ] **Step 1: 本地全量质量门禁**

Run: `bash scripts/check-functions.sh && cd web && npm run lint && npx tsc --noEmit`
Expected: 全过

- [ ] **Step 2: 推送 main 触发 CI/CD**

```bash
git add . && git commit -m "feat(perm): 方案C统一视图/看板 + 全量通俗名（退役11死key）" && git push origin main
```

- [ ] **Step 3: 监控 GHA 部署**

Run: `gh run list --limit 3 && gh run watch`
Expected: Lint + Type Check + Function Check 全过 → 部署成功（3-4 分钟）

- [ ] **Step 4: 验证生产**

4a. 前端：`curl -s https://data.shanhaiyiguo.com/api/health` → ok
4b. 对账：`curl -s -X POST https://data.shanhaiyiguo.com/functions/reconcile-catalog`（或跑 `/api/admin/capabilities`）
   Expected: 红区清零（退役 key 已从 permission 删除 → 无 E-deprecated-key）
4c. Casdoor 权限页：5 个 role-* permission 显示通俗名（经营总览/目标达成/熊喵鲜生/水果/成本可见 + view-board:* / view-kpi:* 通配）
4d. 真实登录：企微客户端登录 → 看板正常、权限正确

- [ ] **Step 5: 收尾**

确认 `gh run view` 成功；`git log --oneline -5` 展示 5 个 commit；无遗留。

---

## Self-Review

### 1. Spec 覆盖
- ✅ 退役 11 个死 key（T1 + T6 迁移）
- ✅ 看板覆盖视图（T2 数据层 + T3/T4 消费侧注入）
- ✅ 全量通俗名（T1 catalog label + T3/T4/T5 消费侧归一 + T6 迁移）
- ✅ 页面级 view:reports/reports-targets 保留（T1 测试钉死）
- ✅ update-permission 全字段（T6 脚本注释 + Global Constraints）
- ✅ H12 单真相（catalog 单副本 + claims/reconcile 静态镜像 + 测试断言防漂移）
- ✅ CATALOG_V 自动 bump（catalog.ts 改动 → GHA hash 变 → 旧令牌刷新）

### 2. 占位符扫描
- T6 脚本 main() 有 `// ...` 占位——需在实现时按 `web/lib/sync/casdoor-client.ts` 模式接通 token 获取。已在 Step 1 注明参考。
- T5 脚本 normKey 的 `classifyDiff` 接线需按现有代码核对（Step 5c 已注明）。

### 3. 类型一致性
- `BOARD_VIEW_COVERAGE`：T2 定义为 `ReadonlyMap<string, readonly string[]>`（boardId → view slugs）；T3/T4 用 `BOARD_VIEW_COVERAGE.get(b.id)` → `data-analysis:view:${v}`。T4 claims.js 静态镜像用 `view-board:brand` 完整 key → 覆盖 key 数组（完整 `data-analysis:view:*`）。**注意不一致**：T2 web 侧 `BOARD_VIEW_COVERAGE` 键 = board id（`brand`），值 = slug（`report_brand_metric_gen`）；T4 claims.js 键 = `data-analysis:view-board:brand`，值 = 完整 key。这是两侧各自的消费形态（web 侧从 b.id 拿，claims 侧从归一后的 key 拿），语义一致但表示不同。T3 buildPermPool 从 `b.id` 拿覆盖 → `data-analysis:view:${v}`（与 T2 一致）；T4 从归一 key 拿（自己加 `data-analysis:view:` 前缀）。文档已写明两侧形态，实现时注意。
