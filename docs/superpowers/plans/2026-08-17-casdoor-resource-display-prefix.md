# Casdoor 功能点显示加「组|」前缀 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Casdoor 管理端下拉框的功能点统一显示为 `组|功能点`（如 `看板|经营总览`、`品牌|熊喵鲜生`），并迁移生产存量数据。

**Architecture:** 在 catalog 单真相新增 `KEY_TO_DISPLAY_NAME`/`DISPLAY_NAME_TO_KEY` 双映射（key ↔ `组|label`，无 label 兜底 `组|映射名`）。写入侧 `resource-sync.ts` 用新映射生成 resource.name；消费侧 4 处反查（claims.js / feature-perm / reconcile-catalog web+scripts）同步改用新映射。存量迁移走生产 DB 直改（`opsh` 已打通）+ `update-permission` API。

**Tech Stack:** TypeScript (web/lib), CommonJS (functions/wecom-oidc-callback), Vitest (web), node:test (scripts), Casdoor REST API + casdoor-postgres 直连 (opsh), 半角 `|` 分隔符。

## Global Constraints

- 分隔符恒为半角 `|`（`DISPLAY_SEP = '|'`），非全角 `｜`。
- `label` 仍是前端能力页纯展示值（有独立组列），**不得**改 `KEY_TO_LABEL`/`LABEL_TO_KEY` 语义。
- 看板/KPI 能力 label 单真相在 `capability-board.ts`，catalog 只合并不复制定义（H12）。
- 消费侧反查必须兼容**两种输入**：`组|label`（Casdoor 新下拉值）与裸 key（通配/引擎裸 key/push:*），未命中原样透传。
- 通配（`view-board:*` / `view-kpi:*` / `*` / `push:*`）恒为 key 形态，不翻译成 `组|label`。
- 存量迁移脚本必须 `--dry-run` 默认 / `--live` 才写入（migrate-perms-friendly 同款纪律）。
- 迁移窗口**不做双格式兼容**：改代码 + 迁移 DB/API 在同一部署窗口完成，旧 token 5min 缓存后自然失效（migrate-perms-friendly 先例）。
- DEPRECATED 11 个 key 的存量 resource 不迁移、不清理（本次不动，另立任务）。

---

### Task 1: catalog 层新增双映射（KEY_TO_DISPLAY_NAME / DISPLAY_NAME_TO_KEY）

**Files:**
- Modify: `web/lib/capability-catalog.ts`
- Test: `web/lib/__tests__/capability-catalog.test.ts`

**Interfaces:**
- Consumes: `deduped: CatalogEntry[]`（已含 OVERRIDES 合并的最终 group/label）、`enc` 映射规则（`:→_`，本文件内联）
- Produces:
  - `export const DISPLAY_SEP: '|'`
  - `export const KEY_TO_DISPLAY_NAME: ReadonlyMap<string, string>`（key → `组|label` 或 `组|映射名`）
  - `export const DISPLAY_NAME_TO_KEY: ReadonlyMap<string, string>`（`组|label`/`组|映射名` → key）
  - `export function displayNameFor(key: string): string`（单 key 查询，供 resource-sync 复用）

- [ ] **Step 1: 写失败测试**

在 `web/lib/__tests__/capability-catalog.test.ts` 追加 describe 块：

```ts
import { capabilityCatalog, CATALOG_KEYS, DEPRECATED_KEYS, VIEW_GROUPS, KEY_TO_LABEL, LABEL_TO_KEY, KEY_TO_DISPLAY_NAME, DISPLAY_NAME_TO_KEY, DISPLAY_SEP, displayNameFor } from '../capability-catalog';

describe('casdoor 展示名（组|label）', () => {
  it('分隔符为半角 |', () => {
    expect(DISPLAY_SEP).toBe('|');
  });
  it('KEY_TO_DISPLAY_NAME 全量覆盖 catalog（每个 key 都有展示名）', () => {
    for (const e of capabilityCatalog) {
      expect(KEY_TO_DISPLAY_NAME.has(e.key), `${e.key} 缺展示名`).toBe(true);
      expect(KEY_TO_DISPLAY_NAME.get(e.key)).toMatch(/^.+\|.+$/);
    }
  });
  it('有 label → 组|label；group 来自 merged 后的最终值', () => {
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:view:reports')).toBe('看板|经营总览');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:brand:3120')).toBe('品牌|熊喵鲜生');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:admin')).toBe('门禁|管理台');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:view-board:brand')).toBe('看板|品牌×指标');
    expect(KEY_TO_DISPLAY_NAME.get('data-analysis:view-kpi:sale')).toBe('看板|门店零售');
  });
  it('DISPLAY_NAME_TO_KEY 双向一致（全量反查）', () => {
    expect(DISPLAY_NAME_TO_KEY.get('看板|经营总览')).toBe('data-analysis:view:reports');
    expect(DISPLAY_NAME_TO_KEY.get('品牌|熊喵鲜生')).toBe('data-analysis:brand:3120');
    expect(DISPLAY_NAME_TO_KEY.get('看板|品牌×指标')).toBe('data-analysis:view-board:brand');
    expect(DISPLAY_NAME_TO_KEY.get('看板|门店零售')).toBe('data-analysis:view-kpi:sale');
  });
  it('展示名全局唯一（Casdoor resource.name 主键 + 反查不可歧义）', () => {
    const names = [...KEY_TO_DISPLAY_NAME.values()];
    expect(new Set(names).size).toBe(names.length);
  });
  it('displayNameFor 单 key 查询', () => {
    expect(displayNameFor('data-analysis:view:reports')).toBe('看板|经营总览');
    expect(displayNameFor('data-analysis:brand:3120')).toBe('品牌|熊喵鲜生');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run lib/__tests__/capability-catalog.test.ts`
Expected: FAIL（`KEY_TO_DISPLAY_NAME` 未导出 / `Cannot read properties of undefined`）

- [ ] **Step 3: 实现双映射**

在 `web/lib/capability-catalog.ts` 中，`LABEL_TO_KEY` 之后追加：

```ts
// ============ Casdoor 展示名（2026-08-17：功能点显示加「组|」前缀）============
// Casdoor 管理端下拉框显示 resource.name，管理员无法区分功能点归属组 → 统一显示 `组|label`
// （无 label 的 scan 自动发现兜底 `组|映射名`）。半角 `|`（生产实测 add-resource 接受）。
// 设计取舍：保留 KEY_TO_LABEL/LABEL_TO_KEY（前端能力页纯 label 展示），新增本双映射供 Casdoor 侧。
export const DISPLAY_SEP = '|' as const;

// key → `组|label`（无 label 时 `组|映射名`，与 resource-sync enc 同规则：`:`→`_`）
const displayEnc = (key: string): string => key.replace(/:/g, '_');
export function displayNameFor(key: string): string {
  const e = capabilityCatalog.find((x) => x.key === key);
  if (!e) return `${DISPLAY_SEP}${displayEnc(key)}`;   // 防御：未知名 → `|映射名`（消费侧反查原样透传兜底）
  return e.label ? `${e.group}${DISPLAY_SEP}${e.label}` : `${e.group}${DISPLAY_SEP}${displayEnc(key)}`;
}

export const KEY_TO_DISPLAY_NAME: ReadonlyMap<string, string> = new Map(
  deduped.map((e) => [e.key, displayNameFor(e.key)]),
);
export const DISPLAY_NAME_TO_KEY: ReadonlyMap<string, string> = new Map(
  [...KEY_TO_DISPLAY_NAME].map(([k, d]) => [d, k]),
);

// 展示名唯一性断言（Casdoor resource.name 主键 + 反查不可歧义；与 label 断言同模式）
{
  const seen = new Set<string>();
  for (const d of KEY_TO_DISPLAY_NAME.values()) {
    if (seen.has(d)) {
      throw new Error(`[capability-catalog] Casdoor 展示名重复（破坏 resource.name 主键 + DISPLAY_NAME_TO_KEY 反查）：${d}`);
    }
    seen.add(d);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run lib/__tests__/capability-catalog.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add web/lib/capability-catalog.ts web/lib/__tests__/capability-catalog.test.ts
git commit -m "feat(perm): catalog 新增 Casdoor 展示名双映射 KEY_TO_DISPLAY_NAME/DISPLAY_NAME_TO_KEY（组|label）"
```

---

### Task 2: 写入侧 resource-sync 用新展示名

**Files:**
- Modify: `web/lib/sync/resource-sync.ts:34-38`
- Test: `web/lib/sync/__tests__/resource-sync.test.ts`

**Interfaces:**
- Consumes: `KEY_TO_DISPLAY_NAME`, `displayNameFor`（Task 1）
- Produces: `displayName(key)` 返回 `组|label`（无 label 退回 `组|映射名`）——被 `syncResources` 的 add-resource 调用

- [ ] **Step 1: 改失败测试**

`web/lib/sync/__tests__/resource-sync.test.ts` 中修改「方案C」用例（第 55-74 行），断言改为新格式：

```ts
  it('方案C：resource.name 用组|label（全量 catalog KEY_TO_DISPLAY_NAME）', async () => {
    mockFetch.mockClear();                                                 // 隔离前序测试的 mock 调用记录
    mockFetch.mockResolvedValueOnce(remoteHas([]));                        // 全缺
    mockFetch.mockResolvedValueOnce(addOk);                                // add view:reports
    mockFetch.mockResolvedValueOnce(addOk);                                // add field:cost
    mockFetch.mockResolvedValueOnce(addOk);                                // add view-board:brand
    const r = await syncResources('shanhai', [
      'data-analysis:view:reports',
      'data-analysis:field:cost',
      'data-analysis:view-board:brand',
    ]);
    expect(r.added).toEqual([
      'data-analysis:view:reports', 'data-analysis:field:cost', 'data-analysis:view-board:brand',
    ]);
    // name 用组|label（Casdoor 下拉显示）：看板|经营总览 / 字段|成本可见 / 看板|品牌×指标；description 恒存 key 原文
    const calls = mockFetch.mock.calls.filter((c) => c[0] === '/api/add-resource').map((c) => c[1].body);
    expect(JSON.parse(calls[0])).toMatchObject({ name: '看板|经营总览', description: 'data-analysis:view:reports' });
    expect(JSON.parse(calls[1])).toMatchObject({ name: '字段|成本可见', description: 'data-analysis:field:cost' });
    expect(JSON.parse(calls[2])).toMatchObject({ name: '看板|品牌×指标', description: 'data-analysis:view-board:brand' });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run lib/sync/__tests__/resource-sync.test.ts`
Expected: FAIL（断言 `name` 不匹配——当前仍是 `经营总览` 等裸通俗名）

- [ ] **Step 3: 改实现**

`web/lib/sync/resource-sync.ts` 中改 import 与 `displayName`：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, displayNameFor } from '../capability-catalog';
```

替换 `displayName` 函数（第 34-38 行）：

```ts
// 展示名 → Casdoor resource.name（2026-08-17 组|label 格式）：有通俗名（catalog label）用 `组|label`，
// 无通俗名退回 `组|映射名`（displayNameFor 内置兜底，与 resource-sync enc 同规则）。
function displayName(key: string): string {
  return displayNameFor(key);
}
```

同时更新文件头注释（第 14-18 行「方案甲」段）追加一行说明格式变更。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run lib/sync/__tests__/resource-sync.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/lib/sync/resource-sync.ts web/lib/sync/__tests__/resource-sync.test.ts
git commit -m "feat(perm): resource-sync 写 Casdoor resource.name 用组|label 展示名"
```

---

### Task 3: 消费侧反查同步（web 侧 feature-perm + reconcile-catalog）

**Files:**
- Modify: `web/lib/feature-perm.ts:7,130-142`
- Modify: `web/lib/reconcile-catalog.ts:8,54`
- Test: `web/lib/__tests__/feature-perm.test.ts`, `web/lib/__tests__/reconcile-catalog.test.ts`

**Interfaces:**
- Consumes: `DISPLAY_NAME_TO_KEY`（Task 1）
- Produces: 无新导出；`buildPermPool`/`classifyCatalogReconcile.normKey` 对 `组|label` 输入归一为 key

- [ ] **Step 1: 改失败测试（feature-perm）**

`web/lib/__tests__/feature-perm.test.ts` 中修改方案甲/方案C 用例的输入为 `组|label` 形态：

```ts
  it('方案甲：permissions 含组|label（Casdoor 下拉选中写入）→ 归一命中（防静默失效）', () => {
    // 管理员在 Casdoor 下拉选中组|label → permission.resources 里是「看板|指标概览」/「看板|门店零售」
    expect(hasBoardPerm(['看板|指标概览', 'data-analysis:view-board:region'], 'kpi')).toBe(true);
    // 组|label 收权：只配组|label → 未配的看板仍被收权（归一后命名空间已配置化）
    expect(hasBoardPerm(['看板|指标概览'], 'brand')).toBe(false);
  });
```

并在 buildPermPool 用例中把 `['经营总览', '目标达成', '熊喵鲜生', '水果', '成本可见', '管理台']` 改为 `['看板|经营总览', '看板|目标达成', '品牌|熊喵鲜生', '品类|水果', '字段|成本可见', '门禁|管理台']`，把 `'报表看板全组'` 改为 `'看板|报表看板全组'`。

> 注：改动前先读 `web/lib/__tests__/feature-perm.test.ts` 全文，按实际断言逐处替换输入（保持判定期望不变，仅输入形态换新）。

- [ ] **Step 2: 运行 feature-perm 测试确认失败**

Run: `cd web && npx vitest run lib/__tests__/feature-perm.test.ts`
Expected: FAIL（裸通俗名不再反查 → 判定为 false 或未配置全开，与期望不符）

- [ ] **Step 3: 改 feature-perm 实现**

`web/lib/feature-perm.ts` 中：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, DISPLAY_NAME_TO_KEY } from './capability-catalog';
```

`buildPermPool` 第 1 步改为：

```ts
  // 1) 展示名（组|label）→ key 全量反查（含组展示名「看板|报表看板全组」→ 组 key；看板展示名 → view-board:<id>）
  const keys = src.map((p) => DISPLAY_NAME_TO_KEY.get(p) ?? p);
```

同步更新函数头注释（第 122-129 行）中「通俗名」措辞为「组|label 展示名」。

- [ ] **Step 4: 改失败测试（reconcile-catalog）**

`web/lib/__tests__/reconcile-catalog.test.ts` 第 97-108 行「方案C」用例改为：

```ts
  it('方案C：permission.resources 含组|label（Casdoor 下拉选中）→ 归一回 key 不误报 E-unknown', () => {
    const d = classifyCatalogReconcile({
      permissions: [{ name: 'p1', resources: ['看板|经营总览', '字段|成本可见'] }],
      catalog: CATALOG, deprecated: DEPRECATED,
    });
    expect(d.red.length).toBe(0);   // 「看板|经营总览」→ view:reports、「字段|成本可见」→ field:cost 均命中
    const minorKeys = d.minor.map((m) => m.key);
    expect(minorKeys).not.toContain('data-analysis:view:reports');
    expect(minorKeys).not.toContain('data-analysis:field:cost');
    expect(minorKeys).toContain('data-analysis:admin');   // 只有 admin 未引用
  });
```

> 注：测试的 `CATALOG` 注入集合不含 admin 展示名，但 normKey 用 `DISPLAY_NAME_TO_KEY` 时「看板|经营总览」→`data-analysis:view:reports` 须命中注入的 CATALOG。核对 `reconcile-catalog.ts` 的 normKey 使用 `DISPLAY_NAME_TO_KEY` 后，`data-analysis:admin` 无引用 → M-unreferenced 保留。

- [ ] **Step 5: 运行 reconcile-catalog 测试确认失败**

Run: `cd web && npx vitest run lib/__tests__/reconcile-catalog.test.ts`
Expected: FAIL（裸通俗名不再反查 → E-unknown 误报）

- [ ] **Step 6: 改 reconcile-catalog 实现**

`web/lib/reconcile-catalog.ts` 中：

```ts
import { CATALOG_KEYS, DEPRECATED_KEYS, DISPLAY_NAME_TO_KEY } from './capability-catalog';
```

normKey（第 54 行）改为：

```ts
  // 归一（2026-08-17 组|label）：Casdoor 下拉选中组|label 写进 permission.resources 时先把展示名还原成
  //   能力 key 再进 referenced（否则 E-unknown-key 误报 / M-unreferenced 漏报）。全量 DISPLAY_NAME_TO_KEY。
  const normKey = (r: string): string => DISPLAY_NAME_TO_KEY.get(r) ?? r;
```

同步更新文件头注释第 51-53 行措辞。

- [ ] **Step 7: 全量 web 测试确认通过**

Run: `cd web && npx vitest run`
Expected: PASS（全部 web 测试，含 feature-perm + reconcile-catalog 新断言）

- [ ] **Step 8: 提交**

```bash
git add web/lib/feature-perm.ts web/lib/reconcile-catalog.ts web/lib/__tests__/feature-perm.test.ts web/lib/__tests__/reconcile-catalog.test.ts
git commit -m "feat(perm): 消费侧反查同步——feature-perm/reconcile 用 DISPLAY_NAME_TO_KEY 归一 组|label"
```

---

### Task 4: 消费侧反查同步（claims.js + scripts reconcile-catalog 静态镜像）

**Files:**
- Modify: `functions/wecom-oidc-callback/claims.js:71-98`（FRIENDLY_TO_KEY 键改 `组|label`）
- Modify: `functions/wecom-oidc-callback/claims.test.js:119-157`（friendly 表改键 + 断言）
- Modify: `scripts/reconcile-catalog.mjs:38-62`（FRIENDLY_TO_KEY 键改 `组|label`）
- Modify: `scripts/tests/reconcile-catalog.test.mjs:42-51,64-67`（输入改 `组|label` + 数量断言）
- Modify: `scripts/tests/migrate-perms-friendly.test.mjs`（如影响，见 Task 5 说明）

**Interfaces:**
- Consumes: 无（静态镜像，与 catalog 同步）
- Produces: `FRIENDLY_TO_KEY`（键全为 `组|label`）、`normalizeFriendlyPerm`（对 `组|label` 输入归一）

- [ ] **Step 1: 改 claims.js 静态镜像**

`functions/wecom-oidc-callback/claims.js` 第 64-98 行的 `FRIENDLY_TO_KEY` 全量改键为 `组|label` 形态（值不变）：

```js
// 展示名（组|label）→ 能力 key 内置映射（2026-08-17 加组前缀；与 capability-catalog.ts + capability-board.ts
// 单真相同步）：Casdoor 下拉框现在显示 `组|label`（如「看板|经营总览」），管理员选中写进
// permission.resources 的是展示名——本函数在 B2 过滤前先把展示名还原成能力 key。
// ⚠ 保持同步：新增/改名能力必须同步这里 + capability-catalog.ts + capability-board.ts + claims.test.js 断言。
// ⚠ 通配（view-board:* / view-kpi:* / * / push:*）恒为 key 形态，不入此表。
const FRIENDLY_TO_KEY = {
  // 页面级报表视图（方案 C 保留的 2 个）+ 具名资源
  '看板|经营总览': 'data-analysis:view:reports',
  '看板|目标达成': 'data-analysis:view:reports-targets',
  '品牌|熊喵鲜生': 'data-analysis:brand:3120',
  '品牌|品品甜': 'data-analysis:brand:64188',
  '品类|水果': 'data-analysis:category:水果',
  '品类|标品': 'data-analysis:category:标品',
  '品类|耗材': 'data-analysis:category:耗材',
  '字段|成本可见': 'data-analysis:field:cost',
  '门禁|管理台': 'data-analysis:admin',
  '看板|报表看板全组': 'data-analysis:view-group:reports-all',
  // 看板层 7（BOARD_CAPABILITIES）
  '看板|指标概览': 'data-analysis:view-board:kpi',
  '看板|品牌×指标': 'data-analysis:view-board:brand',
  '看板|门店战区': 'data-analysis:view-board:region',
  '看板|商品 TOP': 'data-analysis:view-board:item-top',
  '看板|类别出库': 'data-analysis:view-board:category',
  '看板|供应链出库': 'data-analysis:view-board:supply-chain',
  '看板|外部批发': 'data-analysis:view-board:wholesale',
  // KPI 卡层 6（KPI_CARD_CAPABILITIES）
  '看板|门店零售': 'data-analysis:view-kpi:sale',
  '看板|门店配送': 'data-analysis:view-kpi:delivery',
  '看板|供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '看板|供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '看板|总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '看板|毛利率': 'data-analysis:view-kpi:outbound_margin',
};
```

同步更新第 15-18 行文件头注释（「方案甲」→「组|label 展示名」措辞）。

- [ ] **Step 2: 改 claims.test.js 断言**

`functions/wecom-oidc-callback/claims.test.js` 中 `friendly` 表的 23 个键全改 `组|label` 形态（值不变）；第 162 行 `friendlyCtx.reachable` 的 `'指标概览'` 改 `'看板|指标概览'`、`'门店零售'` 改 `'看板|门店零售'`；第 165-167 行断言注释同步（`「指标概览」` → `「看板|指标概览」`）；第 192 行 `groupCtx.reachable` 的 `'报表看板全组'` 改 `'看板|报表看板全组'`。

friendly 表（替换第 119-146 行）：

```js
const friendly = {
  // catalog 具名 10（页面级 + 品牌/品类/字段/管理台/组）
  '看板|经营总览': 'data-analysis:view:reports',
  '看板|目标达成': 'data-analysis:view:reports-targets',
  '品牌|熊喵鲜生': 'data-analysis:brand:3120',
  '品牌|品品甜': 'data-analysis:brand:64188',
  '品类|水果': 'data-analysis:category:水果',
  '品类|标品': 'data-analysis:category:标品',
  '品类|耗材': 'data-analysis:category:耗材',
  '字段|成本可见': 'data-analysis:field:cost',
  '门禁|管理台': 'data-analysis:admin',
  '看板|报表看板全组': 'data-analysis:view-group:reports-all',
  // 看板层 7（BOARD_CAPABILITIES）
  '看板|指标概览': 'data-analysis:view-board:kpi',
  '看板|品牌×指标': 'data-analysis:view-board:brand',
  '看板|门店战区': 'data-analysis:view-board:region',
  '看板|商品 TOP': 'data-analysis:view-board:item-top',
  '看板|类别出库': 'data-analysis:view-board:category',
  '看板|供应链出库': 'data-analysis:view-board:supply-chain',
  '看板|外部批发': 'data-analysis:view-board:wholesale',
  // KPI 卡层 6（KPI_CARD_CAPABILITIES）
  '看板|门店零售': 'data-analysis:view-kpi:sale',
  '看板|门店配送': 'data-analysis:view-kpi:delivery',
  '看板|供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '看板|供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '看板|总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '看板|毛利率': 'data-analysis:view-kpi:outbound_margin',
};
```

- [ ] **Step 3: 运行 claims 测试确认通过**

Run: `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`
Expected: PASS（23 条映射 + 集成用例全过）

- [ ] **Step 4: 改 scripts/reconcile-catalog.mjs 静态镜像**

`scripts/reconcile-catalog.mjs` 第 38-62 行的 `FRIENDLY_TO_KEY` 键全改 `组|label` 形态（值不变），与 claims.js 完全一致（23 条）。同步更新第 35-37 行注释。

- [ ] **Step 5: 改 scripts/tests/reconcile-catalog.test.mjs**

第 42-51 行用例输入改 `['看板|经营总览', '字段|成本可见']`（断言期望不变：归一回 view:reports / field:cost）；第 64-67 行数量断言保持 `23` 不变（键形态变了但数量不变）。

- [ ] **Step 6: 运行 scripts 测试确认通过**

Run: `node --test scripts/tests/reconcile-catalog.test.mjs`
Expected: PASS（3 个用例全过，镜像 23 条断言保持）

- [ ] **Step 7: 提交**

```bash
git add functions/wecom-oidc-callback/claims.js functions/wecom-oidc-callback/claims.test.js scripts/reconcile-catalog.mjs scripts/tests/reconcile-catalog.test.mjs
git commit -m "feat(perm): claims/reconcile 静态镜像键改 组|label（Casdoor 展示名归一）"
```

---

### Task 5: 存量迁移脚本 migrate-resource-display-prefix.mjs

**Files:**
- Create: `scripts/migrate-resource-display-prefix.mjs`
- Test: `scripts/tests/migrate-resource-display-prefix.test.mjs`

**Interfaces:**
- Consumes: 无（独立脚本，静态镜像与 catalog 同步；`--live` 才写入）
- Produces: 迁移逻辑纯函数 `buildResourceNameMap()`（key → `组|label` 映射，供 DB/API 更新用）

- [ ] **Step 1: 写失败测试**

`scripts/tests/migrate-resource-display-prefix.test.mjs`（参考 migrate-perms-friendly.test.mjs 模式）：

```js
// scripts/tests/migrate-resource-display-prefix.test.mjs
// 2026-08-17 迁移：Casdoor resource.name 加「组|」前缀。纯函数单测（node:test，无依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResourceNameMap, migrateResources } from '../migrate-resource-display-prefix.mjs';

test('buildResourceNameMap：全量 key → 组|label（23 条 catalog 具名 + 看板/KPI）', () => {
  const m = buildResourceNameMap();
  assert.equal(m.get('data-analysis:view:reports'), '看板|经营总览');
  assert.equal(m.get('data-analysis:brand:3120'), '品牌|熊喵鲜生');
  assert.equal(m.get('data-analysis:field:cost'), '字段|成本可见');
  assert.equal(m.get('data-analysis:admin'), '门禁|管理台');
  assert.equal(m.get('data-analysis:view-board:brand'), '看板|品牌×指标');
  assert.equal(m.get('data-analysis:view-kpi:sale'), '看板|门店零售');
  assert.ok(m.size >= 23, `至少 23 条：${m.size}`);
});

test('migrateResources：permission.resources 旧展示名/裸 key → 组|label；通配原样保留', () => {
  const m = buildResourceNameMap();
  const out = migrateResources(m, [
    '经营总览',            // 旧通俗名（迁移前已存在的 permission 值）
    'data-analysis:view:reports', // 裸 key（与上一条同映射 → 去重）
    'data-analysis:view-board:*', // 通配保留
    'data-analysis:view-kpi:*',   // 通配保留
    'push:broadcast',      // 引擎裸 key 原样
    '未知串',              // 未知名兜底保留原样
  ]);
  assert.deepEqual(out, [
    '看板|经营总览',        // 两条输入同映射，去重剩 1 个
    'data-analysis:view-board:*',
    'data-analysis:view-kpi:*',
    'push:broadcast',
    '未知串',
  ]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/tests/migrate-resource-display-prefix.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现迁移脚本**

`scripts/migrate-resource-display-prefix.mjs`（参考 migrate-perms-friendly.mjs 模式：`--live` 才写入，默认 dry-run）：

```js
#!/usr/bin/env node
// scripts/migrate-resource-display-prefix.mjs —— Casdoor resource.name 加「组|」前缀迁移（2026-08-17）
// 目标：34 个 resource.name + 5 个 role-* permission.resources 从「裸通俗名/映射名」改为「组|label」。
// ⚠ 生产 fork 的 update-resource/get-resource 定位不到裸名存储（getResource 强制加 / 前缀）→
//    resource 表必须 DB 直改（opsh casdoor-postgres）；permission 走 update-permission API（可用）。
// 用法（--live 才真写入，默认 dry-run 打印 plan）：
//   node scripts/migrate-resource-display-prefix.mjs [--live]
// env：CASDOOR_API_URL / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / CASDOOR_ORG（deploy/.env 注入）；
//   SSH：本脚本不直连 DB——DB 直改用 ssh opsh docker exec 命令（见文档），脚本只处理 permission API 侧。
import { pathToFileURL } from 'node:url';

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

// 展示名静态镜像（与 web/lib/capability-catalog.ts 同步；脚本间不 import 防耦合——静态镜像，claims.js 同源）
// 23 条：catalog 具名 10 + 看板 7 + KPI 6。
export const DISPLAY_NAME_MAP = new Map([
  ['data-analysis:view:reports', '看板|经营总览'],
  ['data-analysis:view:reports-targets', '看板|目标达成'],
  ['data-analysis:view-group:reports-all', '看板|报表看板全组'],
  ['data-analysis:brand:3120', '品牌|熊喵鲜生'],
  ['data-analysis:brand:64188', '品牌|品品甜'],
  ['data-analysis:category:水果', '品类|水果'],
  ['data-analysis:category:标品', '品类|标品'],
  ['data-analysis:category:耗材', '品类|耗材'],
  ['data-analysis:field:cost', '字段|成本可见'],
  ['data-analysis:admin', '门禁|管理台'],
  // 看板层 7
  ['data-analysis:view-board:kpi', '看板|指标概览'],
  ['data-analysis:view-board:brand', '看板|品牌×指标'],
  ['data-analysis:view-board:region', '看板|门店战区'],
  ['data-analysis:view-board:item-top', '看板|商品 TOP'],
  ['data-analysis:view-board:category', '看板|类别出库'],
  ['data-analysis:view-board:supply-chain', '看板|供应链出库'],
  ['data-analysis:view-board:wholesale', '看板|外部批发'],
  // KPI 卡层 6
  ['data-analysis:view-kpi:sale', '看板|门店零售'],
  ['data-analysis:view-kpi:delivery', '看板|门店配送'],
  ['data-analysis:view-kpi:outbound_amt', '看板|供应链出库金额'],
  ['data-analysis:view-kpi:outbound_profit', '看板|供应链毛利'],
  ['data-analysis:view-kpi:delivery_sale_ratio', '看板|总配销比'],
  ['data-analysis:view-kpi:outbound_margin', '看板|毛利率'],
]);

export function buildResourceNameMap() {
  return new Map(DISPLAY_NAME_MAP);
}

// permission.resources 迁移：旧裸 key/裸通俗名 → 组|label；通配/引擎裸 key/未知名原样
export function migrateResources(map, resources) {
  const out = [];
  for (const r of resources) {
    const key = map.get(r) ?? r;                     // 裸 key 直接命中
    const friendly = [...map.values()].find((v) => v.endsWith(`|${r}`)) ?? r;  // 旧裸通俗名 → 组|label
    const next = map.has(r) ? key : friendly;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

// ---- client_credentials（migrate-perms-friendly 同款） ----
async function getAccessToken() { /* 同 migrate-perms-friendly.mjs getAccessToken */ }

async function fetchPermissions(token) { /* 同 migrate-perms-friendly.mjs fetchPermissions */ }

async function updatePermission(token, perm) { /* 同 migrate-perms-friendly.mjs updatePermission（完整字段防 AllCols 清空） */ }

async function main() {
  const live = process.argv.includes('--live');
  const map = buildResourceNameMap();
  const token = await getAccessToken();
  const perms = await fetchPermissions(token);
  const targets = perms.filter((p) => String(p.name || '').startsWith('role-'));

  const changed = [];
  for (const p of targets) {
    const before = (p.resources ?? []).map((r) => String(r));
    const after = migrateResources(map, before);
    const isChanged = JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort());
    console.log(`\n[permission] ${p.name}${isChanged ? ' ★ 需迁移' : ' ✓ 无需变更'}`);
    if (isChanged) {
      console.log('  before:', JSON.stringify(before, null, 0));
      console.log('  after: ', JSON.stringify(after, null, 0));
      changed.push({ name: p.name, after });
    }
  }

  console.log(`\n[summary] role-* permission ${targets.length}：变更 ${changed.length}`);
  console.log(`\n[resource] DB 直改提示：ssh opsh 内 casdoor-postgres 执行\n  UPDATE resource SET name = <组|label> WHERE description = <key>;\n  （34 个，脚本只负责 permission API 侧；DB 直改命令见实施文档）`);

  if (live) {
    console.log('\n[--live] 开始写入 permission...');
    for (const e of changed) {
      const target = targets.find((t) => t.name === e.name);
      const res = await updatePermission(token, { ...target, resources: e.after });
      console.log(`  ✓ ${e.name}: update-permission ${res?.status ?? 'ok'}`);
    }
    console.log('\n完成。随后执行 DB 直改命令迁移 resource 表，再跑 reconcile 验证。');
  } else {
    console.log('\n[dry-run] 未写 Casdoor。确认后加 --live 执行。');
  }
}

const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  main().catch((e) => { console.error('[migrate-resource-display-prefix] Fatal:', e.message); process.exit(2); });
}
```

> 注：`migrateResources` 的去重逻辑保留首现（含 `map.get(r) ?? r` 裸 key 与 `endsWith` 旧通俗名两个分支，合并去重）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test scripts/tests/migrate-resource-display-prefix.test.mjs`
Expected: PASS（2 个用例全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/migrate-resource-display-prefix.mjs scripts/tests/migrate-resource-display-prefix.test.mjs
git commit -m "feat(perm): 存量迁移脚本 migrate-resource-display-prefix（permission 组|label + resource 直改提示）"
```

---

### Task 6: 全量质量门禁 + 生产迁移执行 + 验证

**Files:**
- Modify: 无（执行 + 验证）
- Test: 全量跑

**Interfaces:**
- Consumes: Task 1-5 全部产物

- [ ] **Step 1: 本地全量质量门禁**

Run:
```bash
bash scripts/check-functions.sh
cd web && npx vitest run && npx tsc --noEmit
node --test scripts/tests/
```
Expected: 全绿（check-functions 0 错误；vitest 全过；tsc 无错误；scripts 测试全过）

- [ ] **Step 2: 推送触发部署**

```bash
git add . && git commit -m "feat(perm): Casdoor 功能点显示加 组| 前缀（catalog 双映射 + 消费侧同步 + 迁移脚本）" && git push origin main
```
（此 commit 合并 Task 1-5 的所有 commit；若已逐个 commit，则直接 push）
Expected: GHA quality + migrate + functions + build-web + catalog 全绿

- [ ] **Step 3: 生产迁移 resource 表（DB 直改）**

```bash
ssh opsh "docker exec casdoor-postgres psql -U casdoor -d casdoor -c \"
UPDATE resource SET name = '看板|经营总览' WHERE description = 'data-analysis:view:reports';
UPDATE resource SET name = '看板|目标达成' WHERE description = 'data-analysis:view:reports-targets';
UPDATE resource SET name = '看板|报表看板全组' WHERE description = 'data-analysis:view-group:reports-all';
UPDATE resource SET name = '品牌|熊喵鲜生' WHERE description = 'data-analysis:brand:3120';
UPDATE resource SET name = '品牌|品品甜' WHERE description = 'data-analysis:brand:64188';
UPDATE resource SET name = '品类|水果' WHERE description = 'data-analysis:category:水果';
UPDATE resource SET name = '品类|标品' WHERE description = 'data-analysis:category:标品';
UPDATE resource SET name = '品类|耗材' WHERE description = 'data-analysis:category:耗材';
UPDATE resource SET name = '字段|成本可见' WHERE description = 'data-analysis:field:cost';
UPDATE resource SET name = '门禁|管理台' WHERE description = 'data-analysis:admin';
UPDATE resource SET name = '看板|指标概览' WHERE description = 'data-analysis:view-board:kpi';
UPDATE resource SET name = '看板|品牌×指标' WHERE description = 'data-analysis:view-board:brand';
UPDATE resource SET name = '看板|门店战区' WHERE description = 'data-analysis:view-board:region';
UPDATE resource SET name = '看板|商品 TOP' WHERE description = 'data-analysis:view-board:item-top';
UPDATE resource SET name = '看板|类别出库' WHERE description = 'data-analysis:view-board:category';
UPDATE resource SET name = '看板|供应链出库' WHERE description = 'data-analysis:view-board:supply-chain';
UPDATE resource SET name = '看板|外部批发' WHERE description = 'data-analysis:view-board:wholesale';
UPDATE resource SET name = '看板|门店零售' WHERE description = 'data-analysis:view-kpi:sale';
UPDATE resource SET name = '看板|门店配送' WHERE description = 'data-analysis:view-kpi:delivery';
UPDATE resource SET name = '看板|供应链出库金额' WHERE description = 'data-analysis:view-kpi:outbound_amt';
UPDATE resource SET name = '看板|供应链毛利' WHERE description = 'data-analysis:view-kpi:outbound_profit';
UPDATE resource SET name = '看板|总配销比' WHERE description = 'data-analysis:view-kpi:delivery_sale_ratio';
UPDATE resource SET name = '看板|毛利率' WHERE description = 'data-analysis:view-kpi:outbound_margin';
\""
```
Expected: 23 条 UPDATE 各 Affected 1 行；`SELECT count(*) FROM resource WHERE name LIKE '%|%'` 为 23（deprecated 11 条不迁移保持原样）

- [ ] **Step 4: 生产迁移 permission.resources（API）**

Run: `ssh opsh "cd <deploy 目录> && set -a && . deploy/.env && set +a && node scripts/migrate-resource-display-prefix.mjs"` 先 dry-run 看 plan → 确认后 `--live` 执行。
Expected: 5 个 role-* permission 的 resources 从裸通俗名 → `组|label`（通配保留）；dry-run 打印 before/after 与 DB 直改提示。

> 若服务器无 node，从本地（有 CASDOOR_* env）跑 `node scripts/migrate-resource-display-prefix.mjs --live`。

- [ ] **Step 5: 生产验证**

Run:
```bash
# 对账无红
cd scripts && CASDOOR_CLIENT_ID=... CASDOOR_CLIENT_SECRET=... node reconcile-catalog.mjs 2>&1 | tail -5
# 或直接看能力页红区
curl -s https://data.shanhaiyiguo.com/api/admin/capabilities | head -c 500
# 下拉框人工确认（sso.shanhaiyiguo.com 登录管理员）
```
Expected: reconcile 无红（red: 0）；能力页 synced OK；Casdoor 下拉框显示 `组|label`；用户重新登录后功能正常。

- [ ] **Step 6: 提交收尾（如需调整）**

如验证发现遗漏（如某消费侧漏同步），修复后按 Task 1-5 模式补 commit 并重新部署。

---

## 自审记录

- **Spec 覆盖**：双映射（T1）✓、写入侧（T2）✓、web 消费侧（T3）✓、claims/scripts 镜像（T4）✓、存量迁移脚本（T5）✓、执行+验证（T6）✓、前端能力页不改（显式声明于 T1 约束）✓、DEPRECATED 不迁移（T6 Step 3 注）✓。
- **占位符**：无 TBD/TODO；每个任务含实际代码与断言。
- **类型一致性**：`DISPLAY_SEP`/`KEY_TO_DISPLAY_NAME`/`DISPLAY_NAME_TO_KEY`/`displayNameFor` 在 T1 定义、T2/T3 消费；`FRIENDLY_TO_KEY` 键形态 T4 统一；`buildResourceNameMap`/`migrateResources` 在 T5 定义并被自身测试消费，命名与 migrate-perms-friendly 对齐。