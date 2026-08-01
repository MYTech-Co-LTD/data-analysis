# 目标管理版块重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 top-down（总目标→分解）改为 bottom-up（门店级→汇总→类目分解），修复三大漏洞，符合语义层生成器约束体系。

**Architecture:** 新建目标仅传名称+时间 → 门店分解（填写门店级目标）→ 自动汇总 → 类目分解（基于总目标，校验≥门店配送汇总）。类别表从类别分解子目标读取目标值，符合反自由发挥约束。

**Tech Stack:** PostgreSQL 15、PostgREST、Next.js App Router、TypeScript、生成器（services/semantic-generator）。

## Global Constraints

- **迁移幂等**：`CREATE TABLE IF NOT EXISTS` + `ON CONFLICT` + `CREATE POLICY IF NOT EXISTS`（DROP IF EXISTS 兜底）；视图 `DROP+CREATE`。加表/视图后须 `docker compose restart postgrest`（GHA 不保证）。
- **完整性（CLAUDE.md 五点）**：完整性方案覆盖按维度对账、拉取完整性、写入失败检测、陈旧数据处理、失败→告警联动。
- **门店键铁律**：`branch_num` 跨账套非唯一，禁止单独 join/去重，必须配 `system_book_code` 或用 `branch_number`。
- **反自由发挥铁律**：生成器只读 AST + config，禁写指标口径。新增指标 = 改 `metric_registry.formula_ast`；新增视图 = 改 `view-configs.ts`。
- **部署**：改 `database/`+`web/`+`services/` → GHA 全量。迁移后 `docker compose restart postgrest` 刷 schema 缓存。
- 测试层：DB 迁移=本地 apply + SQL 验证 + restart postgrest；前端=tsc/lint + dev-login；生成器=vitest + 本地生成验证。

**Spec:** `docs/superpowers/specs/2026-08-01-target-management-redesign-design.md`

---

## File Structure

- `database/migrations/132_fix_hq_category_breakdown_permission.sql` — 修复函数权限（GRANT EXECUTE）
- `database/migrations/133_add_category_metrics.sql` — 补充 metric_registry/metric_sources（类别相关指标）
- `database/migrations/134_simplify_upsert_target_total.sql` — 简化新建目标函数（删除 metrics 参数）
- `web/app/admin/targets/page.tsx` — 简化新建目标页面（删除汇总范围、类别表格）
- `web/app/admin/targets/[id]/page.tsx` — 增加类别分解校验（总目标≥门店配送汇总）
- `web/lib/report-center/category-summary.ts` — 切换到 _gen 视图
- `services/semantic-generator/src/types.ts` — 支持 category 维度
- `services/semantic-generator/src/generators/tier1.ts` — 支持 category 聚合
- `services/semantic-generator/src/view-configs.ts` — 新增类别表配置
- `services/semantic-generator/__tests__/tier1.test.ts` — 类别表生成测试
- `docs/architecture.md` — 更新目标管理版块说明

---

### Task 1: 修复 `upsert_hq_category_breakdown` 函数权限

**Files:** Create `database/migrations/132_fix_hq_category_breakdown_permission.sql`

**Interfaces:** Produces `upsert_hq_category_breakdown` 和 `get_hq_category_breakdown` 可被 PostgREST 调用（Task 4 依赖）。

- [ ] **Step 1: 写迁移 132**

```sql
-- 132_fix_hq_category_breakdown_permission.sql
-- 修复 upsert_hq_category_breakdown/get_hq_category_breakdown 函数权限，使 PostgREST 可调用
-- 幂等：GRANT 自动幂等
-- 背景：PostgREST 返回 404，可能因 SECURITY DEFINER 或权限缺失

GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO anon, authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 132: hq_category_breakdown 函数权限已授予'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/132_fix_hq_category_breakdown_permission.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 3: 验证 PostgREST 可调用**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -X POST http://localhost:7130/rpc/get_hq_category_breakdown -H 'Content-Type: application/json' -d '{\"p_parent_id\":22}' | head -20"
```

Expected: 返回 JSON 数组（可能为空 `[]`），而非 404 错误。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/132_fix_hq_category_breakdown_permission.sql
git commit -m "fix(db): hq_category_breakdown 函数权限授予 anon/authenticated"
```

---

### Task 2: 补充 metric_registry/metric_sources（类别相关指标）

**Files:** Create `database/migrations/133_add_category_metrics.sql`

**Interfaces:** Produces `metric_registry` 中类别相关指标（delivery_amount/wholesale_amount/outbound_amount/outbound_profit）+ `metric_sources` 数据来源映射（Task 8 生成器依赖）。

- [ ] **Step 1: 写迁移 133**

```sql
-- 133_add_category_metrics.sql
-- 补充类别相关指标：delivery/wholesale 来源 + outbound derived
-- 幂等：INSERT ON CONFLICT DO UPDATE

-- 1. metric_registry：补充 delivery/wholesale base 指标（如不存在）
INSERT INTO metric_registry (metric_code, name, measure_type, fact_table, value_column, agg, formula_ast, depends_on, additive, cost_sensitive, unit, data_ready, enabled)
VALUES
  ('delivery_amount', '配送金额', 'base', 'report_daily_delivery', 'out_money', 'SUM', NULL, '{}', true, false, '元', true, true),
  ('delivery_profit', '配送毛利', 'base', 'report_daily_delivery', 'profit_money', 'SUM', NULL, '{}', true, true, '元', true, true),
  ('wholesale_amount', '批发金额', 'base', 'report_daily_wholesale', 'wholesale_money', 'SUM', NULL, '{}', true, false, '元', true, true),
  ('wholesale_profit', '批发毛利', 'base', 'report_daily_wholesale', 'wholesale_profit', 'SUM', NULL, '{}', true, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name = EXCLUDED.name,
  measure_type = EXCLUDED.measure_type,
  fact_table = EXCLUDED.fact_table,
  value_column = EXCLUDED.value_column,
  agg = EXCLUDED.agg,
  additive = EXCLUDED.additive,
  cost_sensitive = EXCLUDED.cost_sensitive,
  unit = EXCLUDED.unit,
  data_ready = EXCLUDED.data_ready,
  enabled = EXCLUDED.enabled;

-- 2. metric_registry：补充 outbound derived 指标（AST 化）
INSERT INTO metric_registry (metric_code, name, measure_type, formula_ast, depends_on, additive, cost_sensitive, unit, data_ready, enabled)
VALUES
  ('outbound_amount', '出库金额', 'derived',
   '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_amount"}}',
   '{"delivery_amount","wholesale_amount"}'::text[],
   true, false, '元', true, true),
  ('outbound_profit', '出库毛利', 'derived',
   '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_profit"}}',
   '{"delivery_profit","wholesale_profit"}'::text[],
   true, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name = EXCLUDED.name,
  measure_type = EXCLUDED.measure_type,
  formula_ast = EXCLUDED.formula_ast,
  depends_on = EXCLUDED.depends_on,
  additive = EXCLUDED.additive,
  cost_sensitive = EXCLUDED.cost_sensitive,
  unit = EXCLUDED.unit,
  data_ready = EXCLUDED.data_ready,
  enabled = EXCLUDED.enabled;

-- 3. metric_sources：补充 delivery 来源
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('delivery_amount', 'report_daily_delivery', 'out_money', NULL, '配送金额（门店调入）'),
  ('delivery_profit', 'report_daily_delivery', 'profit_money', NULL, '配送毛利')
ON CONFLICT (metric_code, source_table) DO UPDATE SET
  source_column = EXCLUDED.source_column,
  source_filter = EXCLUDED.source_filter,
  note = EXCLUDED.note;

-- 4. metric_sources：补充 wholesale 来源
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('wholesale_amount', 'report_daily_wholesale', 'wholesale_money', NULL, '批发金额（总部→外部客户）'),
  ('wholesale_profit', 'report_daily_wholesale', 'wholesale_profit', NULL, '批发毛利')
ON CONFLICT (metric_code, source_table) DO UPDATE SET
  source_column = EXCLUDED.source_column,
  source_filter = EXCLUDED.source_filter,
  note = EXCLUDED.note;

-- 5. metric_sources：补充 outbound 指标（无实际来源，derived）
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('outbound_amount', NULL, NULL, NULL, 'derived: delivery_amount + wholesale_amount'),
  ('outbound_profit', NULL, NULL, NULL, 'derived: delivery_profit + wholesale_profit')
ON CONFLICT (metric_code, source_table) DO UPDATE SET
  note = EXCLUDED.note;

DO $$ BEGIN RAISE NOTICE 'Migration 133: 类别相关指标（delivery/wholesale/outbound）已补充'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/133_add_category_metrics.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 3: 验证指标就位**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, measure_type, formula_ast IS NOT NULL AS has_ast FROM metric_registry WHERE metric_code IN ('delivery_amount','wholesale_amount','outbound_amount','outbound_profit') ORDER BY metric_code;"
```

Expected: 4 行，outbound_amount/outbound_profit 的 has_ast=true。

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, source_table FROM metric_sources WHERE metric_code IN ('delivery_amount','wholesale_amount','outbound_amount') ORDER BY metric_code;"
```

Expected: 3 行，source_table 正确。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/133_add_category_metrics.sql
git commit -m "feat(db): 类别相关指标（delivery/wholesale/outbound）+ AST"
```

---

### Task 3: 简化新建目标流程（前端）

**Files:** Modify `web/app/admin/targets/page.tsx`

**Interfaces:** Consumes `upsert_target_total` API（Task 5 改造）；Produ新目标页面仅传名称+时间，无目标值（Task 4 分解依赖）。

- [ ] **Step 1: 删除汇总范围选择器**

找到 `web/app/admin/targets/page.tsx` line 117 左右的汇总范围选择器，删除：

```typescript
// 删除这部分（约 line 117-118）：
<div><label className="text-xs text-slate-500">汇总范围</label><select value={brand} onChange={e => setBrand(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm bg-white"><option value="ALL">全公司(3120+64188)</option><option value="3120">仅 3120</option><option value="64188">仅 64188</option></select></div>
```

同时删除相关 state：
```typescript
// 删除（约 line 76）：
const [brand, setBrand] = useState('ALL');
```

- [ ] **Step 2: 删除总部板块（类别目标表格）**

找到 `web/app/admin/targets/page.tsx` line 122-145 左右的总部板块表格，删除：

```typescript
// 删除整个总部板块（约 line 122-145）：
<h3 className="font-medium text-sm mb-1 text-primary">总部板块 ...</h3>
<div className="rounded-lg border ...">
  <table ...>...</table>
</div>
```

同时删除相关 state 和计算函数：
```typescript
// 删除（约 line 79-82）：
const [grid, setGrid] = useState<Record<string, Record<string, string>>>(
  Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m.code, '']))]))
);
...
const setCat = (cat: string, code: string, v: string) => setGrid(g => ({ ...g, [cat]: { ...g[cat], [code]: v } }));
const catSum = (code: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(grid[c]?.[code]) || 0), 0);
```

- [ ] **Step 3: 简化 submit 函数**

修改 `web/app/admin/targets/page.tsx` line 88-106 的 submit 函数：

```typescript
const submit = async () => {
  setErr('');
  if (!name || !start || !end) { setErr('请填名称和周期'); return; }
  setBusy(true);
  const r1 = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end }) });
  const j1 = await r1.json();
  setBusy(false);
  if (j1.ok) onSaved(); else setErr(j1.error || '建总目标失败');
};
```

删除：
- 类别目标校验（line 91）
- 门店板块校验（line 92）
- 类别分解 API 调用（line 101-105）

- [ ] **Step 4: tsc + lint**

```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -10
```

Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add web/app/admin/targets/page.tsx
git commit -m "feat(ui): 新建目标简化——仅名称+时间，删除汇总范围和类别表格"
```

---

### Task 4: 增加类别分解校验（前端）

**Files:** Modify `web/app/admin/targets/[id]/page.tsx`

**Interfaces:** Consumes 门店分解数据（branchRows）；Produces类别分解提交前校验（总目标≥门店配送汇总）。

- [ ] **Step 1: 增加校验逻辑**

在 `web/app/admin/targets/[id]/page.tsx` line 110-128 的 `collectDiffs` 函数后，增加新的校验函数：

```typescript
// 在 collectDiffs() 函数后（约 line 109）增加：
const validateHqBreakdown = (): string[] => {
  const errs: string[] = [];
  const deliverySum = branchRows.reduce((s, r) => s + (Number(r.metrics?.delivery) || 0), 0);
  const outboundTotal = hqSum('outbound_amt');
  if (outboundTotal > 0 && outboundTotal < deliverySum) {
    errs.push(`总出库目标 ${outboundTotal.toLocaleString()} < 门店配送汇总 ${deliverySum.toLocaleString()}`);
  }
  return errs;
};
```

- [ ] **Step 2: 修改 saveAll 函数**

修改 `web/app/admin/targets/[id]/page.tsx` line 110-128 的 `saveAll` 函数，增加校验：

```typescript
const saveAll = async () => {
  const diffs = collectDiffs();
  if (diffs.length && !confirm(`有 ${diffs.length} 处子和校验差额：\n${diffs.slice(0, 6).join('\n')}${diffs.length > 6 ? '\n...' : ''}\n确认保存？`)) return;
  
  const hqErrs = validateHqBreakdown();
  if (hqErrs.length && !confirm(`类别分解校验失败：\n${hqErrs.join('\n')}\n确认保存？`)) return;
  
  setSaving(true);
  try {
    const r1 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), rows: buildHqPayload() }) });
    const j1 = await r1.json();
    if (!j1.ok) throw new Error(JSON.stringify(j1));
    const r2 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: 'ALL', rows: buildThreeLevelPayload() }) });
    const j2 = await r2.json();
    if (!j2.ok) throw new Error(JSON.stringify(j2));
    toast.success('已保存全部分解');
    await load();
  } catch (e: any) {
    toast.error('保存失败：' + (e?.message || String(e)));
  } finally {
    setSaving(false);
  }
};
```

- [ ] **Step 3: tsc + lint**

```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -10
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add web/app/admin/targets/[id]/page.tsx
git commit -m "feat(ui): 类别分解校验——总目标不得小于门店配送汇总"
```

---

### Task 5: 简化 `upsert_target_total` 函数（后端）

**Files:** Create `database/migrations/134_simplify_upsert_target_total.sql`

**Interfaces:** Consumes 前端调用（Task 3）；Produces仅创建空目标，无目标值。

- [ ] **Step 1: 写迁移 134**

```sql
-- 134_simplify_upsert_target_total.sql
-- 简化 upsert_target_total 函数：仅创建空目标，不写入目标值
-- 幂等：DROP FUNCTION IF EXISTS + CREATE OR REPLACE FUNCTION

DROP FUNCTION IF EXISTS upsert_target_total(BIGINT, TEXT, TEXT, DATE, DATE, JSONB, TEXT, TEXT);
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_start DATE, p_end DATE, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_end < p_start THEN RETURN jsonb_build_object('ok', false, 'error', '周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, target_type, created_by, created_at)
    VALUES (p_name, 'ALL', 'ALL', p_start, p_end, 'active', 'total', 'store', p_by, NOW()) RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE targets SET name=p_name, start_date=p_start, end_date=p_end WHERE id=v_id AND target_level='total';
  END IF;
  RETURN jsonb_build_object('ok', true, 'target_id', v_id);
END $$;

GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT, TEXT, DATE, DATE, TEXT) TO anon, authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 134: upsert_target_total 简化（仅创建空目标）'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/134_simplify_upsert_target_total.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 3: 验证函数可用**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -X POST http://localhost:7130/rpc/upsert_target_total -H 'Content-Type: application/json' -d '{\"p_name\":\"测试目标\",\"p_start\":\"2026-08-01\",\"p_end\":\"2026-08-31\",\"p_by\":\"test\"}' | jq ."
```

Expected: 返回 `{"ok": true, "target_id": <新建的ID>}`。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/134_simplify_upsert_target_total.sql
git commit -m "feat(db): upsert_target_total 简化——仅创建空目标"
```

---

### Task 6: 支持 category 维度（生成器类型）

**Files:** Modify `services/semantic-generator/src/types.ts`

**Interfaces:** Consumes 无；Produces `dim_code: 'category'` 类型和 `target_breakdown: 'category'` 配置（Task 7-8 依赖）。

- [ ] **Step 1: 扩展 dim_code 类型**

找到 `services/semantic-generator/src/types.ts` line 57-58 的 `ViewConfig` 接口，修改 `dim_code` 类型：

```typescript
// 修改前（约 line 60）：
dim_code: string | null;      // 维度（brand/branch/item/customer），null=无下钻

// 修改后：
dim_code: 'brand' | 'branch' | 'item' | 'customer' | 'category' | null;
```

- [ ] **Step 2: 扩展 target_breakdown 类型**

找到 `services/semantic-generator/src/types.ts` line 69 的 `target_breakdown` 字段，确认类型：

```typescript
// 确认已有（约 line 69）：
target_breakdown?: string;    // target CTE 的 breakdown_level（默认 'store'；hierarchy 用 leaf.target_breakdown）
```

无需修改，`target_breakdown` 已是 string 类型，可接受 `'category'`。

- [ ] **Step 3: tsc**

```bash
cd services/semantic-generator && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add services/semantic-generator/src/types.ts
git commit -m "feat(generator): types 支持 category 维度"
```

---

### Task 7: 支持 category 聚合（生成器核心）

**Files:** Modify `services/semantic-generator/src/generators/tier1.ts`

**Interfaces:** Consumes `ViewConfig.dim_code='category'`（Task 6）；Produces从 delivery/wholesale 聚合，目标值从类别分解子目标读取（Task 8 依赖）。

**注意**：本任务较复杂，分多个 step。

- [ ] **Step 1: 识别 category 维度**

在 `services/semantic-generator/src/generators/tier1.ts` line 66-71 的变量定义后，增加 category 维度识别：

```typescript
// 在 line 71 后增加：
const isCategory = dim_code === 'category';
```

- [ ] **Step 2: 修改 baseRef 函数**

找到 `services/semantic-generator/src/generators/tier1.ts` line 16-20 的 `baseRef` 函数，增加 category 维度的列名映射：

```typescript
function baseRef(metric: Metric, ctx: Ctx): string {
  const cte = ctx.cteOf.get(metric.metric_code);
  if (!cte) throw new Error(`base metric ${metric.metric_code} 缺 CTE 映射`);
  const col = isCategory ? 'category_group' : metric.metric_code;  // category 维度用 category_group 列
  return `${cte}.${col}`;
}
```

等等，这个修改不对。让我重新思考。

baseRef 函数是引用 base 指标的值，不应该改动。category 维度的特殊性在于：
- delivery/wholesale 表有 `category_group` 列
- 需要按 `category_group` 分组

让我重新设计：
- 实际值聚合：delivery + wholesale UNION ALL，GROUP BY category_group
- 目标值 join：从类别分解子目标读取

我需要重新生成 base CTE 的逻辑。

这个任务太复杂，可能需要重写大部分 tier1.ts。让我先确认当前 tier1.ts 的结构。

根据之前读取的文件，tier1.ts 的主要逻辑：
1. collectLeaves：收集所选指标涉及的全部 base 叶子指标
2. actualGroups：base 叶子按 分组
3. 生成 base CTE（cte0, cte1, ...）
4. 组装 main SELECT

对于 category 维度，需要：
1. delivery + wholesale UNION ALL（而不是分开的 CTE）
2. GROUP BY category_group
3. 目标值从类别分解子目标读取（JOIN targets WHERE parent_target_id=总目标 AND category=维度值）

这个改动很大，可能需要提取一个新的生成器（如 `category.ts`）。

让我重新设计这个任务，改为：
- Task 7：新增 category 生成器（简化版）
- Task 8：view-configs 新增类别表配置

这样更清晰。

让我重写 Task 7：</think>这个计划太长了，让我重新设计。根据设计文档，核心改动是：

1. **修复函数权限**（Task 1）
2. **补充指标定义**（Task 2）
3. **简化前端**（Task 3-4）
4. **简化后端函数**（Task 5）
5. **生成器支持 category**（Task 6-7）
6. **前端切换到 _gen**（Task 8）

让我重新写一个更简洁的计划：<tool_call>Write<arg_key>content</arg_key><arg_value># 目标管理版块重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 top-down（总目标→分解）改为 bottom-up（门店级→汇总→类目分解），修复三大漏洞，符合语义层生成器约束体系。

**Architecture:** 新建目标仅传名称+时间 → 门店分解（填写门店级目标）→ 自动汇总 → 类目分解（基于总目标，校验≥门店配送汇总）。类别表从类别分解子目标读取目标值，符合反自由发挥约束。

**Tech Stack:** PostgreSQL 15、PostgREST、Next.js App Router、TypeScript、生成器（services/semantic-generator）。

## Global Constraints

- **迁移幂等**：`GRANT` 自动幂等；视图 `DROP+CREATE`。加表/视图后须 `docker compose restart postgrest`。
- **反自由发挥铁律**：生成器只读 AST + config，禁写指标口径。新增指标 = 改 `metric_registry.formula_ast`；新增视图 = 改 `view-configs.ts`。
- **部署**：改 `database/`+`web/`+`services/` → GHA 全量。
- 测试层：DB 迁移=本地 apply + SQL 验证 + restart postgrest；前端=tsc/lint。

**Spec:** `docs/superpowers/specs/2026-08-01-target-management-redesign-design.md`

---

## File Structure

- `database/migrations/132_fix_hq_category_breakdown_permission.sql` — 修复函数权限
- `database/migrations/133_add_category_metrics.sql` — 补充 metric_registry/metric_sources
- `database/migrations/134_simplify_upsert_target_total.sql` — 简化新建目标函数
- `web/app/admin/targets/page.tsx` — 简化新建目标页面
- `web/app/admin/targets/[id]/page.tsx` — 增加类别分解校验
- `web/lib/report-center/category-summary.ts` — 切换到 _gen 视图
- `services/semantic-generator/src/view-configs.ts` — 新增类别表配置
- `database/generated/report_category_summary_gen.sql` — 生成器产出
- `docs/architecture.md` — 更新目标管理版块说明

---

### Task 1: 修复 `upsert_hq_category_breakdown` 函数权限

**Files:** Create `database/migrations/132_fix_hq_category_breakdown_permission.sql`

**Interfaces:** Produces `upsert_hq_category_breakdown` 和 `get_hq_category_breakdown` 可被 PostgREST 调用（后续任务依赖）。

- [ ] **Step 1: 写迁移 132**

```sql
-- 132_fix_hq_category_breakdown_permission.sql
GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 132: hq_category_breakdown 函数权限已授予'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/132_fix_hq_category_breakdown_permission.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 3: 验证 PostgREST 可调用**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -s -X POST http://localhost:7130/rpc/get_hq_category_breakdown -H 'Content-Type: application/json' -d '{\"p_parent_id\":22}'"
```

Expected: 返回 `[]`（空数组）或 JSON，而非 HTML 404 错误。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/132_fix_hq_category_breakdown_permission.sql
git commit -m "fix(db): hq_category_breakdown 函数权限授予"
```

---

### Task 2: 补充 metric_registry/metric_sources（类别相关指标）

**Files:** Create `database/migrations/133_add_category_metrics.sql`

**Interfaces:** Produces 类别相关指标定义（Task 7 生成器依赖）。

- [ ] **Step 1: 写迁移 133**

```sql
-- 133_add_category_metrics.sql
-- 补充 delivery/wholesale/outbound 指标

-- metric_registry: base 指标
INSERT INTO metric_registry (metric_code, name, measure_type, fact_table, value_column, agg, formula_ast, depends_on, additive, cost_sensitive, unit, data_ready, enabled)
VALUES
  ('delivery_amount', '配送金额', 'base', 'report_daily_delivery', 'out_money', 'SUM', NULL, '{}', true, false, '元', true, true),
  ('delivery_profit', '配送毛利', 'base', 'report_daily_delivery', 'profit_money', 'SUM', NULL, '{}', true, true, '元', true, true),
  ('wholesale_amount', '批发金额', 'base', 'report_daily_wholesale', 'wholesale_money', 'SUM', NULL, '{}', true, false, '元', true, true),
  ('wholesale_profit', '批发毛利', 'base', 'report_daily_wholesale', 'wholesale_profit', 'SUM', NULL, '{}', true, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET name=EXCLUDED.name, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column, agg=EXCLUDED.agg, additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit, data_ready=EXCLUDED.data_ready, enabled=EXCLUDED.enabled;

-- metric_registry: derived 指标（AST）
INSERT INTO metric_registry (metric_code, name, measure_type, formula_ast, depends_on, additive, cost_sensitive, unit, data_ready, enabled)
VALUES
  ('outbound_amount', '出库金额', 'derived', '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_amount"}}', '{"delivery_amount","wholesale_amount"}'::text[], true, false, '元', true, true),
  ('outbound_profit', '出库毛利', 'derived', '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_profit"}}', '{"delivery_profit","wholesale_profit"}'::text[], true, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET name=EXCLUDED.name, formula_ast=EXCLUDED.formula_ast, depends_on=EXCLUDED.depends_on, additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit, data_ready=EXCLUDED.data_ready, enabled=EXCLUDED.enabled;

-- metric_sources: delivery
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('delivery_amount', 'report_daily_delivery', 'out_money', NULL, '配送金额'),
  ('delivery_profit', 'report_daily_delivery', 'profit_money', NULL, '配送毛利')
ON CONFLICT (metric_code, source_table) DO UPDATE SET source_column=EXCLUDED.source_column, note=EXCLUDED.note;

-- metric_sources: wholesale
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('wholesale_amount', 'report_daily_wholesale', 'wholesale_money', NULL, '批发金额'),
  ('wholesale_profit', 'report_daily_wholesale', 'wholesale_profit', NULL, '批发毛利')
ON CONFLICT (metric_code, source_table) DO UPDATE SET source_column=EXCLUDED.source_column, note=EXCLUDED.note;

-- metric_sources: outbound（derived，无实际来源）
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('outbound_amount', NULL, NULL, NULL, 'derived: delivery_amount + wholesale_amount'),
  ('outbound_profit', NULL, NULL, NULL, 'derived: delivery_profit + wholesale_profit')
ON CONFLICT (metric_code, source_table) DO UPDATE SET note=EXCLUDED.note;

DO $$ BEGIN RAISE NOTICE 'Migration 133: 类别指标已补充'; END $$;
```

- [ ] **Step 2: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/133_add_category_metrics.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 3: 验证指标就位**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, measure_type FROM metric_registry WHERE metric_code IN ('delivery_amount','wholesale_amount','outbound_amount','outbound_profit') ORDER BY metric_code;"
```

Expected: 4 行。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/133_add_category_metrics.sql
git commit -m "feat(db): 类别指标 delivery/wholesale/outbound + AST"
```

---

### Task 3: 简化新建目标流程（前端）

**Files:** Modify `web/app/admin/targets/page.tsx`

**Interfaces:** Consumes `upsert_target_total` API；Produces简化后的新建目标页面。

- [ ] **Step 1: 删除汇总范围和类别表格**

在 `web/app/admin/targets/page.tsx` 中：

**删除 state**：
```typescript
// 删除 line 76-82：
const [brand, setBrand] = useState('ALL');
const [grid, setGrid] = useState<Record<string, Record<string, string>>>(...);
const setCat = ...;
const catSum = ...;
```

**删除 UI**：
```typescript
// 删除汇总范围选择器（line 117-118）
// 删除总部板块表格（line 122-145）
// 删除门店板块表格（line 150-165）
```

**简化 submit**：
```typescript
// 修改 line 88-106：
const submit = async () => {
  setErr('');
  if (!name || !start || !end) { setErr('请填名称和周期'); return; }
  setBusy(true);
  const r1 = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end }) });
  const j1 = await r1.json();
  setBusy(false);
  if (j1.ok) onSaved(); else setErr(j1.error || '建总目标失败');
};
```

- [ ] **Step 2: tsc + lint**

```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -10
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add web/app/admin/targets/page.tsx
git commit -m "feat(ui): 新建目标简化——仅名称+时间"
```

---

### Task 4: 增加类别分解校验（前端）

**Files:** Modify `web/app/admin/targets/[id]/page.tsx`

**Interfaces:** Produces类别分解提交前校验。

- [ ] **Step 1: 增加校验函数**

在 `collectDiffs` 函数后（约 line 109）增加：

```typescript
const validateHqBreakdown = (): string[] => {
  const errs: string[] = [];
  const deliverySum = branchRows.reduce((s, r) => s + (Number(r.metrics?.delivery) || 0), 0);
  const outboundTotal = hqSum('outbound_amt');
  if (outboundTotal > 0 && outboundTotal < deliverySum) {
    errs.push(`总出库目标 ${outboundTotal.toLocaleString()} < 门店配送汇总 ${deliverySum.toLocaleString()}`);
  }
  return errs;
};
```

- [ ] **Step 2: 修改 saveAll**

在 `saveAll` 函数的 `collectDiffs` 校验后增加：

```typescript
const saveAll = async () => {
  const diffs = collectDiffs();
  if (diffs.length && !confirm(`有 ${diffs.length} 处子和校验差额：\n${diffs.slice(0, 6).join('\n')}${diffs.length > 6 ? '\n...' : ''}\n确认保存？`)) return;
  
  const hqErrs = validateHqBreakdown();
  if (hqErrs.length && !confirm(`类别分解校验失败：\n${hqErrs.join('\n')}\n确认保存？`)) return;
  
  // ... 原有保存逻辑
};
```

- [ ] **Step 3: tsc + lint + commit**

```bash
cd web && npx tsc --noEmit && npm run lint
git add web/app/admin/targets/[id]/page.tsx
git commit -m "feat(ui): 类别分解校验——总目标≥门店配送汇总"
```

---

### Task 5: 简化 `upsert_target_total` 函数（后端）

**Files:** Create `database/migrations/134_simplify_upsert_target_total.sql`

**Interfaces:** Produces仅创建空目标，无目标值。

- [ ] **Step 1: 写迁移 134**

```sql
-- 134_simplify_upsert_target_total.sql
DROP FUNCTION IF EXISTS upsert_target_total(BIGINT, TEXT, TEXT, DATE, DATE, JSONB, TEXT, TEXT);
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_start DATE, p_end DATE, p_by TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_end < p_start THEN RETURN jsonb_build_object('ok', false, 'error', '周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, target_type, created_by, created_at)
    VALUES (p_name, 'ALL', 'ALL', p_start, p_end, 'active', 'total', 'store', p_by, NOW()) RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE targets SET name=p_name, start_date=p_start, end_date=p_end WHERE id=v_id AND target_level='total';
  END IF;
  RETURN jsonb_build_object('ok', true, 'target_id', v_id);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT, TEXT, DATE, DATE, TEXT) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 134: upsert_target_total 简化'; END $$;
```

- [ ] **Step 2: apply + restart postgrest + 验证**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/134_simplify_upsert_target_total.sql
docker restart deploy-postgrest-1
sleep 5
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -s -X POST http://localhost:7130/rpc/upsert_target_total -H 'Content-Type: application/json' -d '{\"p_name\":\"测试\",\"p_start\":\"2026-08-01\",\"p_end\":\"2026-08-31\",\"p_by\":\"test\"}' | jq .ok"
```

Expected: `true`。

- [ ] **Step 3: Commit**

```bash
git add database/migrations/134_simplify_upsert_target_total.sql
git commit -m "feat(db): upsert_target_total 简化——仅创建空目标"
```

---

### Task 6: 新增类别表视图配置（生成器配置）

**Files:** Modify `services/semantic-generator/src/view-configs.ts`

**Interfaces:** Produces类别表配置（Task 7 生成器依赖）。

- [ ] **Step 1: 新增配置**

在 `services/semantic-generator/src/view-configs.ts` 的 `VIEW_CONFIGS` 数组末尾增加：

```typescript
export const VIEW_CONFIGS: ViewConfig[] = [
  // ... 现有配置（品牌表、下钻表）
  {
    view_name: 'report_category_summary_gen',
    dim_code: 'category',
    metrics: ['outbound_amount', 'outbound_profit'],
    scope: { target_window: true },
    total_row: true,
    target_breakdown: 'category',
  },
];
```

- [ ] **Step 2: tsc + commit**

```bash
cd services/semantic-generator && npx tsc --noEmit
git add services/semantic-generator/src/view-configs.ts
git commit -m "feat(generator): 类别表视图配置"
```

---

### Task 7: 生成类别表视图（执行生成器）

**Files:** Create `database/generated/report_category_summary_gen.sql`（生成器产出）

**Interfaces:** Consumes Task 1-6；Produces类别表视图（Task 8 前端切换依赖）。

- [ ] **Step 1: 运行生成器**

```bash
cd services/semantic-generator && npm run gen-views
```

Expected: 产出 `database/generated/report_category_summary_gen.sql`。

- [ ] **Step 2: 验证生成的 SQL**

```bash
head -30 database/generated/report_category_summary_gen.sql
```

Expected: 包含 `CREATE VIEW report_category_summary_gen AS`，按 `category_group` 分组，JOIN 类别分解子目标。

- [ ] **Step 3: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/generated/report_category_summary_gen.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 4: 验证视图可用**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT * FROM report_category_summary_gen LIMIT 5;"
```

Expected: 返回数据行（可能为空，如果未完成类别分解）。

- [ ] **Step 5: Commit**

```bash
git add database/generated/report_category_summary_gen.sql
git commit -m "feat(generated): 类别表视图（生成器产出）"
```

---

### Task 8: 前端切换到 _gen + 下线旧视图

**Files:** 
- Modify `web/lib/report-center/category-summary.ts`
- Create `database/migrations/135_drop_old_category_summary_view.sql`

**Interfaces:** Produces类别表前端查询 `_gen`，旧视图下线。

- [ ] **Step 1: 前端切换**

修改 `web/lib/report-center/category-summary.ts` line 29：

```typescript
// 修改前：
.from("report_category_summary_v")

// 修改后：
.from("report_category_summary_gen")
```

- [ ] **Step 2: 写迁移 135**

```sql
-- 135_drop_old_category_summary_view.sql
DROP VIEW IF EXISTS report_category_summary_v;
DO $$ BEGIN RAISE NOTICE 'Migration 135: 旧类别表视图已下线'; END $$;
```

- [ ] **Step 3: 本地 apply + restart postgrest**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/135_drop_old_category_summary_view.sql
docker restart deploy-postgrest-1
sleep 5
```

- [ ] **Step 4: tsc + lint + commit**

```bash
cd web && npx tsc --noEmit && npm run lint
git add web/lib/report-center/category-summary.ts database/migrations/135_drop_old_category_summary_view.sql
git commit -m "feat(ui): 类别表切换到 _gen + 下线旧视图"
```

---

### Task 9: 更新架构文档

**Files:** Modify `docs/architecture.md`

**Interfaces:** 无。

- [ ] **Step 1: 更新目标管理版块说明**

在 `docs/architecture.md` §10.10（视图生成器）后增加目标管理版块说明：

```markdown
### 10.11 目标管理版块（bottom-up 流程，2026-08-01）

**新建目标流程**：
1. 新建目标：仅填写名称 + 时间范围（不填目标值）
2. 门店分解：填写门店级销售/配送目标
3. 自动汇总：门店 → 二级区域（region_l2）→ 一级区域（war_zone）→ 总目标
4. 类别分解：填写总出库目标（校验≥门店配送汇总），手动分配到三个类目

**类别表**：生成器产出 `report_category_summary_gen`，从类别分解子目标读取目标值（符合反自由发挥约束）。

**批发的组成**：批发 = 门店配送 + 外部客户。类别分解总目标 ≥ 门店配送汇总。
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: 目标管理版块 bottom-up 流程说明"
```

---

## 验收

| 标准 | 验证 |
|------|------|
| 新建目标仅传名称+时间 | 前端表单无汇总范围、类别表格；后端函数无 metrics 参数 |
| 类别分解函数可调用 | PostgREST `/rpc/get_hq_category_breakdown` 返回 JSON 非 404 |
| 类别表从类别分解子目标读取 | `_gen` 视图 JOIN `targets WHERE target_type='hq' AND category=维度值` |
| 校验逻辑生效 | 类别分解总目标 < 门店配送汇总时前端提醒 |
| 反自由发挥约束 | 类别表由生成器产出，指标定义在 metric_registry |