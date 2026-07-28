# 门店维度与品牌归属固化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让门店键全局唯一、品牌归属由维表决定，根除目标管理里 `branch_num` 跨账套重复导致的门店塌缩/品牌错标。

**Architecture:** 方案 A——门店键真相 = `(system_book_code, branch_num)` 复合；`dim_branch`/`targets` 加生成列 `branch_number`（从复合键派生、全局唯一）作开发键；`get_breakdown`/`upsert_target_breakdown` 改复合键、删 `LIMIT 1` 乱取；前端按 `branch_number` 标识门店；DB FK + 视图收口 + 文档 + CI 守护测试四层防再犯。

**Tech Stack:** PostgreSQL 15.18（生成列/部分唯一索引/NOT VALID FK）、Next.js App Router、PostgREST RPC、vitest（前端 lib）、Shell（守护测试）。

## Global Constraints

- **门店键铁律**：`branch_num` 跨账套重复（实测 128 个共享、对应不同物理店）、**非全局唯一**。门店键 = `(system_book_code, branch_num)` 复合 或派生 `branch_number`。**禁止 branch_num 单独 join / 去重 / 做 PK / 做 `.eq()`。**
- **迁移幂等**：`ADD COLUMN IF NOT EXISTS`、`CREATE OR REPLACE FUNCTION`（显式 `SECURITY DEFINER`）、约束先 `IF NOT EXISTS`。视图用 `DROP VIEW IF EXISTS + CREATE VIEW`。
- **采集/外部数据字段用 TEXT**，不用 VARCHAR。
- **加表/加列后须 `docker compose restart postgrest`** 刷 schema 缓存。
- **部署**：改 `database/` + `web/` → GHA 全量部署（`git add . && git commit && git push origin main`）。
- 测试层（testing-handbook §2）：DB/RPC = 本地 migrate 重跑 + SQL 数据验证 + restart postgrest；前端 lib = vitest；前端 UI = tsc/lint + dev-login 手动。
- 本地 dev 容器名同 prod（`deploy-postgres-1` 等）。本地若缺数据，SQL 验证可改在 prod 跑（SSH 只读 SELECT）。

**Spec:** `docs/superpowers/specs/2026-07-28-store-brand-dimension-reform-design.md`

---

## File Structure

- `database/migrations/097_dim_branch_branch_number.sql` — dim_branch 加生成列 branch_number + 唯一索引
- `database/migrations/098_get_breakdown_composite.sql` — get_breakdown storeRows 带 sbc/branch_number/brand + metrics 复合键
- `database/migrations/099_upsert_target_breakdown_composite.sql` — upsert 复合键、删 LIMIT 1
- `database/migrations/100_targets_branch_number_fk.sql` — targets 加 branch_number + FK(NOT VALID) + 部分唯一索引
- `web/app/admin/targets/[id]/page.tsx` — 分解页改用 branch_number 标识门店（key/setStoreCell/payload/import）
- `web/app/api/admin/targets/breakdown/route.ts` — 透传 per-row system_book_code（基本无需改，验证）
- `scripts/guard-branch-num.sh` — CI 守护：扫描 branch_num-only 用法
- `docs/architecture.md` — 已更新（§3 门店键不变式）
- `CLAUDE.md` — 加门店键铁律

---

### Task 1: dim_branch 加全局唯一开发键 branch_number

**Files:**
- Create: `database/migrations/097_dim_branch_branch_number.sql`

**Interfaces:**
- Produces: `dim_branch.branch_number`（TEXT，`GENERATED ALWAYS AS (system_book_code || '-' || LPAD(branch_num,4,'0')) STORED`，全局唯一）；供 Task 4 FK、Task 2 视图、Task 5 前端使用。

- [ ] **Step 1: 写迁移 097**

```sql
-- 097_dim_branch_branch_number.sql
-- 门店全局唯一开发键 branch_number：从复合PK(system_book_code,branch_num)派生
-- 幂等：ADD COLUMN IF NOT EXISTS；部署后 restart postgrest
ALTER TABLE dim_branch ADD COLUMN IF NOT EXISTS branch_number TEXT
  GENERATED ALWAYS AS (system_book_code || '-' || LPAD(branch_num, 4, '0')) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dim_branch_branch_number ON dim_branch(branch_number);

DO $$ BEGIN RAISE NOTICE 'Migration 097: dim_branch.branch_number (全局唯一开发键)'; END $$;
```

- [ ] **Step 2: 本地重跑迁移**

```bash
cd /Users/duo/Documents/mytechcode/data-analysis
# 按既有方式重跑全部迁移（migrate.sh 每次部署重跑全部）
bash scripts/migrate.sh 2>&1 | tail -5
# 或直接对本地 dev 库执行单文件：
# docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/097_dim_branch_branch_number.sql
```
Expected: `Migration 097 ...` notice，无报错。

- [ ] **Step 3: 验证 branch_number 生成 + 唯一**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "
SELECT system_book_code, branch_num, branch_number, branch_name FROM dim_branch WHERE branch_num IN ('48','109') ORDER BY branch_num, system_book_code;
SELECT count(*) AS rows, count(DISTINCT branch_number) AS distinct_bn, count(*) FILTER (WHERE branch_number IS NULL) AS nulls FROM dim_branch;"
```
Expected: 48 号两店 branch_number 分别 `3120-0048` / `64188-0048`；rows = distinct_bn、nulls=0。

- [ ] **Step 4: restart postgrest 刷 schema 缓存**

```bash
docker compose restart postgrest
```

- [ ] **Step 5: Commit**

```bash
git add database/migrations/097_dim_branch_branch_number.sql
git commit -m "feat(db): dim_branch 加全局唯一开发键 branch_number(派生自复合PK)"
```

---

### Task 2: get_breakdown storeRows 带品牌 + metrics 复合键

**Files:**
- Create: `database/migrations/098_get_breakdown_composite.sql`

**Interfaces:**
- Consumes: `dim_branch.branch_number`（Task 1）、`dim_brand`（品牌名）
- Produces: `get_breakdown` 返回的 `storeRows` 每行多了 `system_book_code`/`branch_number`/`brand_name`；metrics 子查询按 `(s.system_book_code=b.system_book_code AND s.branch_num=b.branch_num)` 匹配（修共享 branch_num 错配）。

- [ ] **Step 1: 写迁移 098（CREATE OR REPLACE FUNCTION get_breakdown）**

```sql
-- 098_get_breakdown_composite.sql
-- get_breakdown 重建：storeRows 带 system_book_code/branch_number/brand_name；
--   metrics 子查询改复合键(修共享branch_num错配)；ORDER BY 含 system_book_code
-- 幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_build_object(
    'warZoneRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='war_zone'),'[]'::jsonb),
    'regionRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'region_l2',t.region_l2,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone,t.region_l2) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='region_l2'),'[]'::jsonb),
    'storeRows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'system_book_code',b.system_book_code,
        'branch_number',b.branch_number,
        'brand_name',br.brand_name,
        'branch_num',b.branch_num,'branch_name',b.branch_name,
        'war_zone',b.first_level_region,'region_l2',b.second_level_region,'group',e.custom_group,
        'metrics',COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value)
          FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
          WHERE s.parent_target_id=p_parent_id AND s.breakdown_level='store'
            AND s.system_book_code=b.system_book_code AND s.branch_num=b.branch_num),'{}'::jsonb))
      ORDER BY b.system_book_code, b.first_level_region, b.second_level_region, b.branch_num)
      FROM dim_branch b
      LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
      LEFT JOIN dim_brand br ON br.system_book_code=b.system_book_code
      WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99'),'[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 098: get_breakdown storeRows 带 sbc/branch_number/brand'; END $$;
```

- [ ] **Step 2: 本地重跑 + restart postgrest**

```bash
bash scripts/migrate.sh 2>&1 | tail -3 && docker compose restart postgrest
```

- [ ] **Step 3: 验证 storeRows 字段 + 共享 branch_num 不串**

```bash
# 取 parent 22（sbc=ALL）的 storeRows，看 48 号两店是否各自一行、品牌正确
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "
SELECT json_array_elements((get_breakdown(22)->>'storeRows')::json)->>'branch_number' AS bn,
       json_array_elements((get_breakdown(22)->>'storeRows')::json)->>'system_book_code' AS sbc,
       json_array_elements((get_breakdown(22)->>'storeRows')::json)->>'brand_name' AS brand
QUALIFY bn LIKE '%-0048' OR bn LIKE '%-0109';" 2>/dev/null || \
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "
WITH r AS (SELECT json_array_elements((get_breakdown(22)->>'storeRows')::json) AS j)
SELECT j->>'branch_number' AS bn, j->>'system_book_code' AS sbc, j->>'brand_name' AS brand FROM r
WHERE j->>'branch_number' IN ('3120-0048','64188-0048','3120-0109','64188-0109');"
```
Expected: 4 行，3120→熊喵鲜生、64188→品品甜。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/098_get_breakdown_composite.sql
git commit -m "fix(db): get_breakdown storeRows 带品牌+branch_number, metrics 改复合键(修共享branch_num错配)"
```

---

### Task 3: upsert_target_breakdown 复合键（治根 + 回归测试）

**Files:**
- Create: `database/migrations/099_upsert_target_breakdown_composite.sql`
- Create: `database/migrations/_regression/upsert_shared_branchnum_test.sql`（自包含回归测试，部署不跑、仅本地验证）

**Interfaces:**
- Consumes: 前端 POST `rows` 每行带 `system_book_code`（Task 5 产出）
- Produces: `upsert_target_breakdown` 门店级按 `(parent_target_id, system_book_code, branch_num)` 定位/去重；`system_book_code` 取传入值、不再 `LIMIT 1`。

- [ ] **Step 1: 写迁移 099（CREATE OR REPLACE FUNCTION upsert_target_breakdown）**

```sql
-- 099_upsert_target_breakdown_composite.sql
-- upsert_target_breakdown 重建：门店级按复合键定位/去重，品牌取传入 system_book_code，
--   删除 063 的 "SELECT system_book_code FROM dim_branch WHERE branch_num=v_branch LIMIT 1" 乱取
-- 幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_level TEXT; v_branch TEXT; v_wz TEXT; v_r2 TEXT; v_m TEXT;
  v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_level := COALESCE(v_row->>'breakdown_level', 'store');
    v_branch := v_row->>'branch_num';
    v_wz := v_row->>'war_zone';
    v_r2 := v_row->>'region_l2';
    IF v_level='store' THEN
      -- 品牌 = 前端传入(get_breakdown 来源)，不再 LIMIT 1 乱取
      v_store_sbc := COALESCE(v_row->>'system_book_code', p_sbc);
      -- 战区/二级区域 从 dim_branch 按复合键确定取
      SELECT first_level_region, second_level_region INTO v_wz, v_r2
        FROM dim_branch WHERE system_book_code=v_store_sbc AND branch_num=v_branch;
    ELSE
      v_store_sbc := p_sbc;
    END IF;
    IF v_level='store' THEN
      -- 复合键定位（去掉 LIMIT 1）：共享 branch_num 两店各自独立
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='store'
        AND system_book_code=v_store_sbc AND branch_num=v_branch;
    ELSIF v_level='war_zone' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='war_zone' AND war_zone=v_wz LIMIT 1;
    ELSIF v_level='region_l2' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='region_l2' AND war_zone=v_wz AND region_l2=v_r2 LIMIT 1;
    END IF;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, war_zone, region_l2, created_by, created_at)
      SELECT t.name||'-'||COALESCE(v_branch, v_wz, v_r2), v_store_sbc, COALESCE(v_branch,'ALL'), t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, t.target_type, v_level, v_wz, v_r2, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id RETURNING id INTO v_sub;
    ELSE
      UPDATE targets SET system_book_code=v_store_sbc, war_zone=v_wz, region_l2=v_r2 WHERE id=v_sub;
      DELETE FROM target_metric_values WHERE target_id=v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value) VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n:=n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count',n);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 099: upsert_target_breakdown 复合键(删 LIMIT 1 乱取)'; END $$;
```

- [ ] **Step 2: 本地重跑 + restart postgrest**

```bash
bash scripts/migrate.sh 2>&1 | tail -3 && docker compose restart postgrest
```

- [ ] **Step 3: 写回归测试（共享 branch_num 两店 → 两行、sbc 各正确）**

Create `database/migrations/_regression/upsert_shared_branchnum_test.sql`:
```sql
-- 回归测试：共享 branch_num 的两品牌门店，upsert 后应得两行、system_book_code 各正确
-- 不参与部署（_regression 目录被 migrate 忽略）；本地手动跑：psql < 此文件
BEGIN;
-- 选一对真实共享 branch_num（48: 3120 曲靖师宗1店 / 64188 品品甜昆明1店）
SELECT upsert_target_breakdown(
  22, 'ALL',
  '[{"breakdown_level":"store","system_book_code":"3120","branch_num":"48","metrics":{"sale":100,"delivery":50}},
    {"breakdown_level":"store","system_book_code":"64188","branch_num":"48","metrics":{"sale":200,"delivery":80}}]'::jsonb,
  'regression_test');
SELECT system_book_code, branch_num,
       (SELECT jsonb_object_agg(metric_code,target_value) FROM target_metric_values mv WHERE mv.target_id=t.id) AS metrics
FROM targets t
WHERE t.parent_target_id=22 AND t.breakdown_level='store' AND t.branch_num='48'
ORDER BY t.system_book_code;
ROLLBACK;
```

- [ ] **Step 4: 跑回归测试**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/_regression/upsert_shared_branchnum_test.sql
```
Expected: 输出 2 行（3120/48 sale=100、64188/48 sale=200），`metrics` 各自正确、互不覆盖。ROLLBACK 不留痕。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/099_upsert_target_breakdown_composite.sql database/migrations/_regression/upsert_shared_branchnum_test.sql
git commit -m "fix(db): upsert_target_breakdown 复合键定位+删LIMIT1乱取; 加共享branch_num回归测试"
```

---

### Task 4: targets 加 branch_number + FK(NOT VALID) + 部分唯一索引

**Files:**
- Create: `database/migrations/100_targets_branch_number_fk.sql`

**Interfaces:**
- Consumes: `dim_branch.branch_number`（Task 1，FK 目标）
- Produces: `targets.branch_number`（生成列，仅 store 级非空）；FK 防新增脏数据；部分唯一索引防同父同店两行。

- [ ] **Step 1: 写迁移 100**

```sql
-- 100_targets_branch_number_fk.sql
-- targets 加门店级 branch_number(生成,仅store级) + FK(NOT VALID,容历史) + 部分唯一索引
-- 幂等：ADD COLUMN IF NOT EXISTS；约束 IF NOT EXISTS；部署后 restart postgrest
ALTER TABLE targets ADD COLUMN IF NOT EXISTS branch_number TEXT
  GENERATED ALWAYS AS (
    CASE WHEN breakdown_level='store' AND branch_num<>'ALL'
      THEN system_book_code || '-' || LPAD(branch_num, 4, '0')
      ELSE NULL END
  ) STORED;

-- FK：新插入/更新校验 branch_number 须存在于 dim_branch；NOT VALID 不校验历史(79歧义+1孤儿)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_branch_number_fkey') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_branch_number_fkey
      FOREIGN KEY (branch_number) REFERENCES dim_branch(branch_number) NOT VALID;
  END IF;
END $$;

-- 同一父目标下，一个门店(branch_number)只能有一个 store 目标
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_parent_store_branch
  ON targets(parent_target_id, branch_number) WHERE breakdown_level='store';

DO $$ BEGIN RAISE NOTICE 'Migration 100: targets.branch_number + FK(NOT VALID) + partial unique'; END $$;
```

- [ ] **Step 2: 本地重跑 + restart postgrest**

```bash
bash scripts/migrate.sh 2>&1 | tail -3 && docker compose restart postgrest
```

- [ ] **Step 3: 验证生成列 + FK + 唯一索引**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "
SELECT breakdown_level, count(*) FILTER (WHERE branch_number IS NOT NULL) AS has_bn, count(*) AS n FROM targets GROUP BY 1 ORDER BY 1;
\di idx_targets_parent_store_branch"
```
Expected: 仅 `store` 级 has_bn>0，其他级 has_bn=0；索引存在。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/100_targets_branch_number_fk.sql
git commit -m "feat(db): targets 加 branch_number(生成) + FK(NOT VALID) + 部分唯一索引(防门店塌缩)"
```

---

### Task 5: 分解页改用 branch_number 标识门店

**Files:**
- Modify: `web/app/admin/targets/[id]/page.tsx`
- Modify: `web/lib/report-center/import-diff.ts`（TargetMetricRow 加 system_book_code，diff 按 branch_number）
- Verify: `web/app/api/admin/targets/breakdown/route.ts`（透传 rows 已含 system_book_code，无需改）

**Interfaces:**
- Consumes: `get_breakdown` storeRows 现含 `system_book_code`/`branch_number`/`brand_name`（Task 2）；`upsert_target_breakdown` 接收 per-row `system_book_code`（Task 3）
- Produces: 分解页 store 行 React key/setStoreCell/payload/import 统一用 `branch_number`。

- [ ] **Step 1: import-diff.ts 的 TargetMetricRow 加 system_book_code，diff 按 branch_number**

`web/lib/report-center/import-diff.ts` — 把 `branch_num` 主键改为 `branch_number`（兼容回退 branch_num+sbc）。修改接口与函数：
```ts
export interface TargetMetricRow {
  branch_number?: string;      // 新：全局唯一门店键
  branch_num: string;
  system_book_code?: string;   // 新
  branch_name?: string;
  metrics: Record<string, number>;
}

function rowKey(r: TargetMetricRow): string {
  // 优先 branch_number；回退 system_book_code-branch_num；再回退 branch_num
  return r.branch_number || (r.system_book_code ? `${r.system_book_code}-${r.branch_num}` : `-${r.branch_num}`);
}

export function diffImport(current: TargetMetricRow[], incoming: TargetMetricRow[], metrics: string[] = ['sale','delivery']): DiffEntry[] {
  const curMap = new Map(current.map(r => [rowKey(r), r]));
  const diffs: DiffEntry[] = [];
  for (const inc of incoming) {
    const cur = curMap.get(rowKey(inc));
    for (const m of metrics) {
      const oldVal = Number(cur?.metrics?.[m]) || 0;
      const newVal = Number(inc.metrics?.[m]) || 0;
      if (oldVal !== newVal) {
        diffs.push({
          branch_num: inc.branch_num, branch_name: inc.branch_name ?? cur?.branch_name, metric: m,
          oldValue: oldVal, newValue: newVal, diff: newVal - oldVal,
        });
      }
    }
  }
  return diffs;
}
```
（`DiffEntry.branch_num` 保留，仅展示用。）

- [ ] **Step 2: vitest 验 import-diff（若有现成测试则更新）**

```bash
cd web && npx vitest run lib/report-center/__tests__ 2>&1 | tail -20
```
Expected: 通过（若现有测试断言带 branch_num，按新 rowKey 更新断言）。

- [ ] **Step 3: page.tsx — setStoreCell 改按 branch_number**

`web/app/admin/targets/[id]/page.tsx:70`：
```ts
const setStoreCell = (bnKey: string, m: string, v: string) =>
  setBranchRows(rs => rs.map(r => (r.branch_number || `${r.system_book_code}-${r.branch_num}`) === bnKey
    ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
```

- [ ] **Step 4: page.tsx — buildThreeLevelPayload store 行带 system_book_code**

`web/app/admin/targets/[id]/page.tsx:79` 改为：
```ts
    ...branchRows.map(r => ({ breakdown_level: 'store', system_book_code: r.system_book_code, branch_num: r.branch_num, metrics: Object.fromEntries(STORE_METRICS.map(m => [m, Number(r.metrics?.[m]) || 0])) })),
```

- [ ] **Step 5: page.tsx — React key + input 用 branch_number**

`web/app/admin/targets/[id]/page.tsx:289` 与 `:293`：
```tsx
                        {r2Open && r2Stores.map(store => {
                          const unfilled = STORE_METRICS.every(m => !store.metrics?.[m]);
                          const hit = matchKw(store);
                          const storeKey = store.branch_number || `${store.system_book_code}-${store.branch_num}`;
                          return (
                            <tr key={storeKey} className={`hover:bg-slate-50 ${unfilled ? 'bg-slate-50/60' : ''} ${hit ? 'bg-amber-50' : ''}`}>
                              <td className="border border-slate-200 p-2"></td>
                              <td className="border border-slate-200 p-2"></td>
                              <td className={`border border-slate-200 p-2 ${hit ? 'ring-1 ring-inset ring-amber-300' : ''}`}>
                                <span className="text-xs text-slate-400 mr-1 tabular-nums">{store.brand_name ? `[${store.brand_name}]` : ''}</span>
                                <span className="text-xs text-slate-400 mr-2 tabular-nums">{store.branch_num}</span>{store.branch_name}{unfilled && <span className="ml-2 text-xs text-slate-400">未填</span>}
                              </td>
                              {STORE_METRICS.map(m => <td key={m} className="border border-slate-200 p-2"><input type="number" value={store.metrics?.[m] ?? ''} onChange={e => setStoreCell(storeKey, m, e.target.value)} className="border rounded-md px-2 py-1 w-32 text-sm text-right tabular-nums" /></td>)}
```
（门店名前加 `[品牌]` 角标，让共享 branch_num 两店肉眼可分。）

- [ ] **Step 6: page.tsx — 导入映射带 system_book_code/branch_number**

`web/app/admin/targets/[id]/page.tsx:137-138` 与 `:149-153`：
```ts
        const incoming: TargetMetricRow[] = j.rows.map((x: any) => ({ branch_number: x.branch_number, system_book_code: x.system_book_code, branch_num: x.branch_num, branch_name: x.branch_name, metrics: x.metrics }));
        const cur: TargetMetricRow[] = branchRows.map(b => ({ branch_number: b.branch_number, system_book_code: b.system_book_code, branch_num: b.branch_num, branch_name: b.branch_name, metrics: b.metrics }));
```
confirmImport 内按 rowKey 匹配：
```ts
    const byKey = Object.fromEntries(pendingRows.map(x => [x.branch_number || `${x.system_book_code}-${x.branch_num}`, x.metrics]));
    setBranchRows(rs => rs.map(rw => { const k = rw.branch_number || `${rw.system_book_code}-${rw.branch_num}`; return byKey[k] ? { ...rw, metrics: { ...rw.metrics, ...byKey[k] } } : rw; }));
    const existing = new Set(branchRows.map(r => r.branch_number || `${r.system_book_code}-${r.branch_num}`));
    const added = pendingRows.filter(r => !existing.has(r.branch_number || `${r.system_book_code}-${r.branch_num}`))
      .map(r => ({ system_book_code: r.system_book_code, branch_number: r.branch_number, branch_num: r.branch_num, branch_name: r.branch_name || '', war_zone: '', region_l2: '', metrics: r.metrics }));
```
> 注：Excel 模板 `/api/admin/targets/template` 若不带 system_book_code，导入只能匹配 branch_num（共享号会歧义）。模板补列另开任务（见 §不做/后续）；本轮导入仅支持已带 sbc 的来源，否则对共享号提示用户手选。

- [ ] **Step 7: tsc + lint**

```bash
cd web && npx tsc --noEmit 2>&1 | tail -20 && npm run lint 2>&1 | tail -20
```
Expected: 0 error。

- [ ] **Step 8: dev-login 手动验证**

本地起前端，打开 `/admin/targets/<parent_id>` 分解页：确认门店列表共享 branch_num（如 48）出现两行（带 `[熊喵鲜生]`/`[品品甜]` 角标）；各填不同目标值；保存后刷新，两行各自保持、互不覆盖。

- [ ] **Step 9: Commit**

```bash
git add web/app/admin/targets/\[id\]/page.tsx web/lib/report-center/import-diff.ts
git commit -m "fix(web): 分解页门店改用 branch_number 标识(修共享branch_num塌缩); import-diff 按复合键"
```

---

### Task 6: 历史回填导出 + 孤儿清理

**Files:**
- Create: `scripts/export_ambiguous_targets.sql`（导出 79 歧义清单）
- Create: `database/migrations/101_cleanup_orphan_targets.sql`（清 1 孤儿）

**Interfaces:**
- 无下游接口依赖；产出供用户复核的清单 + 清理孤儿以备后续 VALIDATE FK。

- [ ] **Step 1: 导出 79 共享 branch_num 歧义清单**

`scripts/export_ambiguous_targets.sql`:
```sql
-- 导出 parent 22 下、共享 branch_num 的门店目标清单，交用户逐个确认归属
WITH tgt AS (SELECT DISTINCT parent_target_id, branch_num FROM targets WHERE breakdown_level='store' AND parent_target_id=22)
SELECT t.parent_target_id, t.branch_num,
       d3120.branch_name AS store_3120_name, d64188.branch_name AS store_64188_name,
       t.system_book_code AS current_sbc, (SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id) AS current_metrics
FROM tgt JOIN targets t ON t.parent_target_id=tgt.parent_target_id AND t.breakdown_level='store' AND t.branch_num=tgt.branch_num
LEFT JOIN dim_branch d3120 ON d3120.system_book_code='3120' AND d3120.branch_num=t.branch_num
LEFT JOIN dim_branch d64188 ON d64188.system_book_code='64188' AND d64188.branch_num=t.branch_num
WHERE EXISTS (SELECT 1 FROM dim_branch WHERE branch_num=t.branch_num AND system_book_code='3120')
  AND EXISTS (SELECT 1 FROM dim_branch WHERE branch_num=t.branch_num AND system_book_code='64188')
ORDER BY t.branch_num;
```
Run + 落盘交用户：
```bash
mkdir -p scripts/out
docker exec deploy-postgres-1 psql -U postgres -d insforge -A -F$'\t' -c "$(cat scripts/export_ambiguous_targets.sql)" > scripts/out/ambiguous_targets_22.tsv
```
Expected: ~79 行 TSV；**交用户复核**：每个 branch_num 的目标是 3120 店 / 64188 店 / 两家各一。

- [ ] **Step 2: 清 1 孤儿目标（branch_num 在 dim_branch 两边查无）**

`database/migrations/101_cleanup_orphan_targets.sql`:
```sql
-- 101_cleanup_orphan_targets.sql
-- 清理 store 级孤儿目标：branch_num 在 dim_branch 查无（门店已关/改名），阻碍后续 VALIDATE FK
-- 幂等：DELETE 是幂等的（无则不删）；部署后 restart postgrest
WITH orphan AS (
  SELECT t.id FROM targets t
  WHERE t.breakdown_level='store' AND t.branch_num<>'ALL'
    AND NOT EXISTS (SELECT 1 FROM dim_branch d WHERE d.system_book_code=t.system_book_code AND d.branch_num=t.branch_num)
)
DELETE FROM target_metric_values WHERE target_id IN (SELECT id FROM orphan);
DELETE FROM targets WHERE id IN (SELECT id FROM orphan);
DO $$ BEGIN RAISE NOTICE 'Migration 101: 清理孤儿 store 目标'; END $$;
```

- [ ] **Step 3: 本地重跑 + 验证孤儿=0**

```bash
bash scripts/migrate.sh 2>&1 | tail -3
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "
SELECT count(*) AS orphans FROM targets t
WHERE t.breakdown_level='store' AND t.branch_num<>'ALL'
  AND NOT EXISTS (SELECT 1 FROM dim_branch d WHERE d.system_book_code=t.system_book_code AND d.branch_num=t.branch_num);"
```
Expected: orphans = 0。

- [ ] **Step 4: Commit**

```bash
git add scripts/export_ambiguous_targets.sql scripts/out/ambiguous_targets_22.tsv database/migrations/101_cleanup_orphan_targets.sql
git commit -m "chore(targets): 导出79共享branch_num歧义清单+清孤儿; 待用户复核后重录品品甜"
```

> 品品甜门店目标重录（79 共享号用户确认后 + 64188 独有店）属用户操作，改造后 UI 已支持复合键；不在本任务自动化范围。

---

### Task 7: CI 守护测试 — 扫 branch_num-only 用法

**Files:**
- Create: `scripts/guard-branch-num.sh`
- Modify: `.github/workflows/<ci>.yml`（挂到 lint 步骤后；若 CI 文件位置不明，先提供脚本、挂载由部署同改）

**Interfaces:**
- 产出：CI 中扫描 `JOIN ... ON branch_num`（无 system_book_code）、`.eq("branch_num"`（无伴 `.eq("system_book_code"`）的用法，命中则非零退出。

- [ ] **Step 1: 写守护脚本**

```bash
#!/usr/bin/env bash
# scripts/guard-branch-num.sh
# 守护门店键铁律：禁止 branch_num 单独 join/去重/.eq（必须配 system_book_code 或用 branch_number）
# 允许的例外（白名单）：已知安全的 branch_num-only 引用，按路径或上下文豁免
set -euo pipefail
hit=0

echo "[guard] 扫描 ON branch_num（须配 system_book_code）..."
# 匹配 "ON x.branch_num = y.branch_num" 但同行无 system_book_code
if grep -rnE "ON\s+\w+\.branch_num\s*=\s*\w+\.branch_num" \
    database/migrations web/app web/lib services 2>/dev/null \
  | grep -viE "system_book_code|branch_number" \
  | grep -vE "(_regression|node_modules|\.next)"; then
  echo "❌ 发现 branch_num-only JOIN（缺 system_book_code/branch_number）"; hit=1
fi

echo "[guard] 扫描 .eq(\"branch_num\" 单列（无伴 .eq(\"system_book_code\"）..."
# 启发式：.eq("branch_num" 出现的文件，若同处无 system_book_code/branch_number，告警
for f in $(grep -rlE '\.eq\(["'\'']branch_num["'\'']' web/app web/lib 2>/dev/null | grep -vE "node_modules|\.next"); do
  if ! grep -qE "system_book_code|branch_number" "$f"; then
    echo "❌ $f 用 .eq(\"branch_num\") 但无 system_book_code/branch_number"; hit=1
  fi
done

if [ "$hit" -ne 0 ]; then echo "[guard] ❌ 违反门店键铁律，请改用复合键或 branch_number"; exit 1; fi
echo "[guard] ✅ 通过"
```

- [ ] **Step 2: 跑守护脚本**

```bash
chmod +x scripts/guard-branch-num.sh && ./scripts/guard-branch-num.sh
```
Expected: 列出当前违反点（如 region_breakdown_v 等已知 branch_num-only 处），逐个判定：纳入白名单 or 修。已知遗留（spec §4 声明只审计不改的 `report_region_breakdown_v` 硬编码 64188）加白名单注释。

- [ ] **Step 3: 挂进 CI（lint 后）**

在 `.github/workflows/` 的 CI workflow lint 步骤后加：
```yaml
      - name: Guard branch_num usage
        run: bash scripts/guard-branch-num.sh
```

- [ ] **Step 4: Commit**

```bash
git add scripts/guard-branch-num.sh .github/workflows/
git commit -m "test(ci): 守护门店键铁律——禁 branch_num 单独 join/.eq"
```

---

### Task 8: 文档不变式

**Files:**
- Modify: `CLAUDE.md`（加门店键铁律）
- `docs/architecture.md` §3 — 已更新（Task 0 / 本次 spec 已改）

**Interfaces:**
- 无。

- [ ] **Step 1: CLAUDE.md 加铁律**

在 `CLAUDE.md` 「采集任务数据完整性规则」之后新增一节：
```markdown
## 门店键铁律（重要）

`branch_num` 跨 lemeng 账套（数据源）重复——3120(熊喵) 与 64188(品品甜) 各自从 1 编号，**128 个 branch_num 两账套都有但对应不同物理门店**，非全局唯一。

- **门店键 = `(system_book_code, branch_num)` 复合，或派生 `branch_number`（=`sbc`-`branch_num`，全局唯一）**。
- **禁止用 `branch_num` 单独 join / 去重 / 做 PK / 做 `.eq()`。** 必须配 `system_book_code` 或用 `branch_number`。
- 品牌 = `system_book_code`（3120=熊喵鲜生、64188=品品甜），由 `dim_branch` 决定，目标录入不出品牌选择器。
- 品牌拆分：实际值按 `report_daily_*.system_book_code` GROUP BY；目标值按复合键门店目标 SUM。
- 品牌归属/配送语义详见 `docs/superpowers/specs/2026-07-28-store-brand-dimension-reform-design.md`。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 加门店键铁律(branch_num非唯一,须复合键/branch_number)"
```

---

## 部署（全部任务完成后）

```bash
git push origin main   # 触发 GHA 全量部署（database/ + web/ 改动）
gh run watch           # 等 5 steps 全绿
# 部署后 prod 验证：
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) FILTER (WHERE branch_number IS NOT NULL) FROM dim_branch;\""
curl -s https://data.shanhaiyiguo.com/api/health
```
- 部署不保证重启 postgrest → GHA 后若新列/RPC 400 `schema cache`，手动 `docker compose restart postgrest`。
- 品牌表（report-center Phase 2 的品牌×指标表）待用户复核 79 歧义 + 重录品品甜目标后，另开 spec。
