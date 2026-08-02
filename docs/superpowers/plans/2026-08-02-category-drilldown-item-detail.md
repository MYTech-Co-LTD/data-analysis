# 品类看板下钻商品明细 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 品类看板行可点 → 抽屉显示该品类商品明细；删除独立「出库商品明细」看板，能力并入抽屉；顺带修掉按细类 top_category 筛 0 行的 latent bug。

**Architecture:** dim_item 加 `category_group` STORED 生成列（复用 093 CASE，把商品→粗类映射统一到 dim 源头）→ 商品视图经 view-config `extra` 裸列携带（不动生成器代码，守铁律）→ lib/API 筛选改 `category_group` → 品类行可点开 `CategoryItemDrawer`（搜索/排序/分页/点行→商品详情）→ 删 `ItemOutboundList` 独立看板。

**Tech Stack:** PostgreSQL 15（STORED 生成列）、语义层生成器（services/semantic-generator，tsx+vitest）、Next.js 15 App Router、TypeScript、lucide-react。

**Spec:** `docs/superpowers/specs/2026-08-02-category-drilldown-item-detail-design.md`

## Global Constraints

- **迁移幂等**：`ADD COLUMN IF NOT EXISTS ... GENERATED ALWAYS AS (...) STORED`（重跑跳过）；视图 `DROP+CREATE`。加列/视图后须 `docker compose restart postgrest` 刷 schema 缓存。
- **反自由发挥铁律**：本次只改 `view-configs.ts` 的 `extra` 裸列名（生成器已有 `MAX(di.${ex}) AS ${ex}` 机制），**不改生成器代码**。
- **粗类映射（093 权威，逐字复用）**：`CASE split_part(COALESCE(category_path,''),'->',1) WHEN '生鲜' THEN '水果' WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品' WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材' ELSE '其他' END`。
- **成本脱敏**：商品视图已有 `CASE WHEN can_see_cost THEN ... END`；`category_group` 是维度列非敏感，不套脱敏。
- **部署**：改 `database/`+`services/`+`web/` → GHA 全量。生成器产物 `report_item_breakdown_gen.sql` 须先在 prod 跑 `gen-views` 重生成并提交，再 push。
- **测试层**：DB 迁移=本地 apply + SQL 验证；生成器=vitest；前端=tsc --noEmit + lint。

---

## File Structure

- `database/migrations/150_dim_item_category_group.sql` — 新建：dim_item 加 category_group 生成列
- `services/semantic-generator/src/view-configs.ts` — 改：itemBreakdownView.extra 加 'category_group'
- `services/semantic-generator/__tests__/tier1.test.ts` — 改：加 category_group 携带测试
- `database/generated/report_item_breakdown_gen.sql` — 重生成（controller 跑 gen-views）
- `web/lib/report-center/item-breakdown.ts` — 改：筛选 top_category→category_group + 类型加 category_group
- `web/components/report-center/category-item-drawer.tsx` — 新建：品类下钻抽屉
- `web/components/report-center/category-summary.tsx` — 改：行可点 + drawer 状态 + targetId prop
- `web/components/report-center/item-outbound-list.tsx` — **删除**
- `web/app/reports/targets/[id]/desktop.tsx` — 改：移除 ItemOutboundList + CategorySummary 传 targetId + 去 itemList prop
- `web/app/reports/targets/[id]/mobile.tsx` — 同上
- `web/app/reports/targets/[id]/page.tsx` — 改：移除 getItemOutboundListPage 预取 + itemList prop

---

### Task 1: 数据层——dim_item category_group 生成列 + 视图 config + 测试

**Files:**
- Create: `database/migrations/150_dim_item_category_group.sql`
- Modify: `services/semantic-generator/src/view-configs.ts:190`（itemBreakdownView.dim_grain.extra）
- Test: `services/semantic-generator/__tests__/tier1.test.ts`（describe('Tier1 dim_grain') 内加测试）

**Interfaces:**
- Produces: `dim_item.category_group` 列（Task 2 依赖，gen-views 时视图才能引用）；`itemBreakdownView` 配置携带 category_group（Task 2 生成视图产物含该列）。

- [ ] **Step 1: 写迁移 150**

Create `database/migrations/150_dim_item_category_group.sql`:
```sql
-- 150_dim_item_category_group.sql
-- dim_item 加 category_group STORED 生成列：商品→粗类映射（水果/标品/耗材/其他）。
-- 复用 093_unify_category_group 的 CASE 口径，把映射统一到 dim 源头（delivery/wholesale 日后可复用）。
-- 用途：品类看板下钻——report_item_breakdown_gen 携带 category_group，按粗类筛商品明细。
-- 幂等：ADD COLUMN IF NOT EXISTS，重跑跳过。表达式全 immutable（CASE+split_part+coalesce），PG15 支持。
-- 采集安全：dim_item 经 PostgREST upsert 写（web/lib/collect-items.ts），payload 不含 category_group，不冲突。
ALTER TABLE dim_item
ADD COLUMN IF NOT EXISTS category_group TEXT
GENERATED ALWAYS AS (
  CASE split_part(COALESCE(category_path,''),'->',1)
    WHEN '生鲜' THEN '水果'
    WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
    WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
    ELSE '其他'
  END
) STORED;
DO $$ BEGIN RAISE NOTICE 'Migration 150: dim_item.category_group 生成列（粗类，复用 093 CASE）'; END $$;
```

- [ ] **Step 2: 本地 apply + 验证列就位**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 < database/migrations/150_dim_item_category_group.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT category_group, count(*) FROM dim_item GROUP BY 1 ORDER BY 2 DESC;"
```
Expected: 迁移成功（NOTICE 150）；查询返回 水果/标品/耗材/其他（标品含废弃档案+广西柳州合并），或本地无数据时仅返回列不报错。若本地 dev 库 dim_item 为空，补验表达式正确性：
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT category_path, CASE split_part(COALESCE(category_path,''),'->',1) WHEN '生鲜' THEN '水果' WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品' WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材' ELSE '其他' END AS cg FROM dim_item WHERE category_path IS NOT NULL LIMIT 5;"
```

- [ ] **Step 3: 改 view-configs（itemBreakdownView.extra 加 'category_group'）**

Modify `services/semantic-generator/src/view-configs.ts`，把 itemBreakdownView 的 dim_grain.extra（约 line 190）改为：
```typescript
    extra: ['item_name', 'category_name', 'top_category', 'item_brand', 'category_group'],
```
（仅末尾追加 `'category_group'`，其余不动。）

- [ ] **Step 4: 写生成器测试（裸列 category_group 被 MAX 携带）**

在 `services/semantic-generator/__tests__/tier1.test.ts` 的 `describe('Tier1 dim_grain', ...)` 块内，紧跟现有 `it('actual CTE join dim table 做 grain 变换 + extra 列', ...)` 之后，新增：
```typescript
  it('extra 含生成列 category_group（裸列 MAX 携带，不改生成器）', () => {
    const config: ViewConfig = {
      view_name: 'test_item_cat_group',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name', 'category_group'],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('MAX(di.category_group) AS category_group');
    expect(sql).toContain('JOIN dim_item di');
  });
```

- [ ] **Step 5: 跑测试**

```bash
cd services/semantic-generator && npx vitest run __tests__/tier1.test.ts
```
Expected: 全部通过（含新增测试）。

- [ ] **Step 6: tsc**

```bash
cd services/semantic-generator && npx tsc --noEmit
```
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add database/migrations/150_dim_item_category_group.sql services/semantic-generator/src/view-configs.ts services/semantic-generator/__tests__/tier1.test.ts
git commit -m "feat(data): dim_item.category_group 生成列(复用093 CASE) + item视图extra携带——品类下钻口径对齐"
```

---

### Task 2: controller——prod 跑 gen-views 重生成 item 视图 + 提交产物

> ⚠️ 控制器任务（须 SSH 隧道 + prod 凭证），不派 subagent。依赖 Task 1（150 已建文件 + config 改完）。

**Files:**
- Modify: `database/generated/report_item_breakdown_gen.sql`（gen-views 产出）

**Interfaces:**
- Produces: 提交后的 `report_item_breakdown_gen.sql` 含 `MAX(di.category_group) AS category_group`（Task 6 GHA 部署依赖）。

- [ ] **Step 1: prod apply 150（gen-views 前列须存在）**

按 [[prod-db-tunnel-container-ip]] 模式。150 文件 Task 1 已提交但 prod 代码尚未 rsync（GHA 在 Task 6），故先从本地 scp 上去再 apply：
```bash
# 1. 本地 scp 150 到 prod 宿主机 /tmp
scp -i ~/.ssh/ShanHai-OPS.pem database/migrations/150_dim_item_category_group.sql root@data.shanhaiyiguo.com:/tmp/150.sql
# 2. 宿主机 docker cp 进容器 + psql 执行
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker cp /tmp/150.sql deploy-postgres-1:/tmp/150.sql && docker exec deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 -f /tmp/150.sql"
```
Expected: `NOTICE: Migration 150...`，无 ERROR。验证：
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT category_group, count(*) FROM dim_item GROUP BY 1 ORDER BY 2 DESC;\""
```
返回 水果/标品/耗材/其他（标品含废弃档案+广西柳州合并）。

- [ ] **Step 2: 隧道 + gen-views 重生成**

```bash
# 取容器 IP
PG_IP=$(ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' deploy-postgres-1")
# 后台隧道
ssh -i ~/.ssh/ShanHai-OPS.pem -o StrictHostKeyChecking=no -L 15433:${PG_IP}:5432 -N -f root@data.shanhaiyiguo.com
# 取 prod 密码（容器 env 权威，非 deploy/.env）
PROD_PW=$(ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker inspect deploy-postgres-1 --format '{{range .Config.Env}}{{println .}}{{end}}'" | grep '^POSTGRES_PASSWORD=' | head -1 | cut -d= -f2-)
# 跑生成器（读 prod metric_registry + 直接 DROP+CREATE prod 视图）
cd services/semantic-generator && DATABASE_URL="postgresql://postgres:${PROD_PW}@localhost:15433/insforge" npm run gen-views
```
Expected: 生成器成功，所有视图（含 report_item_breakdown_gen）在 prod 重 CREATE。本地 `database/generated/report_item_breakdown_gen.sql` 被更新。

- [ ] **Step 3: restart postgrest + 验证产物**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```
验证生成产物含 category_group（本地）：
```bash
grep "category_group" database/generated/report_item_breakdown_gen.sql
```
Expected: 含 `MAX(di.category_group) AS category_group`。
验证 prod 视图查粗类分布（对标品类看板口径）：
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT category_group, count(*) items, ROUND(SUM(outbound_amount)) outbound FROM report_item_breakdown_gen WHERE target_id=22 GROUP BY 1 ORDER BY 1;\""
```
Expected: 返回 水果/标品/耗材/其他 行，水果+标品+耗材的 outbound 合计 ≈ 品类看板 22 的 sale_actual 合计（同 delivery+wholesale 口径）。

- [ ] **Step 4: Commit 生成产物**

```bash
git add database/generated/report_item_breakdown_gen.sql
git commit -m "feat(generated): report_item_breakdown_gen 重生成——携带 category_group（品类下钻）"
```

---

### Task 3: lib——筛选 top_category→category_group + 类型

**Files:**
- Modify: `web/lib/report-center/item-breakdown.ts:129-179`（ItemOutboundListRow 类型 + getItemOutboundListPage）

**Interfaces:**
- Produces: `getItemOutboundListPage` 按 `category_group` 筛（修 latent bug）；`ItemOutboundListRow` 加 `category_group` 字段（Task 4 抽屉行类型依赖）。

- [ ] **Step 1: 类型加 category_group**

Modify `web/lib/report-center/item-breakdown.ts`，在 `ItemOutboundListRow` interface（约 line 129）加字段。改后完整 interface：
```typescript
export interface ItemOutboundListRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  top_category: string | null;
  category_group: string | null;
  delivery_amount: number;
  wholesale_amount: number;
  outbound_amount: number;
  pct: number; // 占比（前端可基于 total 重算，这里给 0 占位）
}
```

- [ ] **Step 2: select 加 category_group + 筛选改 category_group + map 加字段**

Modify `getItemOutboundListPage`（约 line 144-179）。改动点：

select 字符串（约 line 152-154）加 `category_group`：
```typescript
    .select(
      "item_code,item_name,category_name,top_category,category_group,delivery_amount,wholesale_amount,outbound_amount",
      { count: "exact" },
    )
```

筛选（约 line 157）`top_category` → `category_group`：
```typescript
  if (filters.category) query = query.eq("category_group", filters.category);
```

map（约 line 168-177）加 `category_group`，改后完整 map：
```typescript
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    item_code: String(r.item_code ?? ""),
    item_name: String(r.item_name ?? ""),
    category_name: r.category_name == null ? null : String(r.category_name),
    top_category: r.top_category == null ? null : String(r.top_category),
    category_group: r.category_group == null ? null : String(r.category_group),
    delivery_amount: Number(r.delivery_amount || 0),
    wholesale_amount: Number(r.wholesale_amount || 0),
    outbound_amount: Number(r.outbound_amount || 0),
    pct: 0,
  }));
```

- [ ] **Step 3: tsc**

```bash
cd web && npx tsc --noEmit
```
Expected: 无错误（删 ItemOutboundList 在 Task 5，本任务暂不动消费方；item-outbound-list.tsx 仍引用 ItemOutboundListRow，加字段不破坏）。

- [ ] **Step 4: Commit**

```bash
git add web/lib/report-center/item-breakdown.ts
git commit -m "fix(lib): item-list 筛选 top_category->category_group(修0行latent bug) + 类型加 category_group"
```

---

### Task 4: 新组件 CategoryItemDrawer

**Files:**
- Create: `web/components/report-center/category-item-drawer.tsx`

**Interfaces:**
- Consumes: `/api/admin/reports/item-list`（Task 3 已改 category_group 筛选）+ `ItemDetailDrawer`（现有）。
- Produces: `CategoryItemDrawer` 组件，props `{ targetId: number; category: string; onClose: () => void }`（Task 5 集成依赖）。

- [ ] **Step 1: 写组件**

Create `web/components/report-center/category-item-drawer.tsx`:
```tsx
"use client";

// 品类下钻抽屉：点品类看板某品类行弹出，显示该品类商品明细。
// 取数 /api/admin/reports/item-list（lib 已按 category_group 筛，修了 top_category 0 行 bug）。
// 无 URL 同步（抽屉本地态，避免污染主看板 URL）。行点开 -> ItemDetailDrawer（现有）。
import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Search, Loader2 } from "lucide-react";
import { ItemDetailDrawer } from "./item-detail-drawer";
import type { ItemOutboundListRow } from "@/lib/report-center/item-breakdown";

const PAGE_SIZE = 50;

function fmtCell(v: number | null | undefined): string {
  if (v == null) return "-";
  return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : v.toFixed(0);
}

type SortKey = "outbound" | "delivery" | "wholesale" | "name";
type SortDir = "asc" | "desc";

interface Props {
  targetId: number;
  category: string;
  onClose: () => void;
}

export function CategoryItemDrawer({ targetId, category, onClose }: Props) {
  const [rows, setRows] = useState<ItemOutboundListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerItem, setDrawerItem] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("outbound");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const fetchPage = async (p: number, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/reports/item-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, page: p, category, q: query }),
      }).then((x) => x.json());
      if (r?.ok === false) {
        setError(typeof r.error === "string" ? r.error : "加载失败");
        return;
      }
      setRows(Array.isArray(r?.rows) ? r.rows : []);
      setTotal(typeof r?.total === "number" ? r.total : 0);
      setPage(p);
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  // 切品类/目标时重拉首页
  useEffect(() => {
    setQ("");
    setQInput("");
    fetchPage(1, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, targetId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };
  const getSortVal = (r: ItemOutboundListRow): number | string => {
    if (sortKey === "name") return r.item_name;
    if (sortKey === "outbound") return r.outbound_amount;
    if (sortKey === "delivery") return r.delivery_amount;
    return r.wholesale_amount;
  };
  const sortedRows = [...rows].sort((a, b) => {
    const av = getSortVal(a);
    const bv = getSortVal(b);
    if (typeof av === "string" || typeof bv === "string") {
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return sortDir === "asc" ? av - bv : bv - av;
  });
  const sortIcon = (k: SortKey) =>
    sortKey === k ? (
      sortDir === "asc" ? (
        <ChevronUp size={13} strokeWidth={1.5} />
      ) : (
        <ChevronDown size={13} strokeWidth={1.5} />
      )
    ) : null;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex h-full w-[720px] max-w-[94vw] flex-col overflow-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">
            {category} · 商品明细
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="关闭"
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </div>

        {/* 搜索 */}
        <div className="mb-2 flex items-center gap-2 text-xs">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setQ(qInput);
                  fetchPage(1, qInput);
                }
              }}
              placeholder="搜商品名"
              className="w-full rounded border border-slate-200 py-1 pl-7 pr-2 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => {
              setQ(qInput);
              fetchPage(1, qInput);
            }}
            className="rounded bg-slate-100 px-3 py-1 text-slate-700 hover:bg-slate-200"
          >
            搜索
          </button>
        </div>

        {/* 表 */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
              <tr>
                <th
                  onClick={() => onSort("name")}
                  className="cursor-pointer select-none px-3 py-2 text-left font-medium hover:text-slate-700"
                >
                  <span className="inline-flex items-center gap-1">
                    商品
                    {sortIcon("name")}
                  </span>
                </th>
                <th className="px-3 py-2 text-left font-medium">品类</th>
                <th
                  onClick={() => onSort("delivery")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    配送
                    {sortIcon("delivery")}
                  </span>
                </th>
                <th
                  onClick={() => onSort("wholesale")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    批发
                    {sortIcon("wholesale")}
                  </span>
                </th>
                <th
                  onClick={() => onSort("outbound")}
                  className="cursor-pointer select-none px-3 py-2 text-right font-medium hover:text-slate-700"
                >
                  <span className="inline-flex flex-row-reverse items-center gap-1">
                    出库
                    {sortIcon("outbound")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                    <Loader2 size={14} className="mr-1 inline animate-spin" />
                    加载中…
                  </td>
                </tr>
              ) : sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                    暂无数据
                  </td>
                </tr>
              ) : (
                sortedRows.map((r) => (
                  <tr
                    key={r.item_code}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setDrawerItem(r.item_code)}
                  >
                    <td className="px-3 py-2 text-slate-700">{r.item_name}</td>
                    <td className="px-3 py-2 text-slate-700">{r.category_name ?? "-"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtCell(r.delivery_amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtCell(r.wholesale_amount)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-800">
                      {fmtCell(r.outbound_amount)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

        {/* 分页 */}
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <span className="tabular-nums">共 {total} 条</span>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1 || loading}
              onClick={() => fetchPage(page - 1, q)}
              aria-label="上一页"
              className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
            >
              <ChevronLeft size={14} strokeWidth={1.5} />
            </button>
            <span className="px-2 tabular-nums">
              {page}/{totalPages}
            </span>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => fetchPage(page + 1, q)}
              aria-label="下一页"
              className="rounded border border-slate-200 px-2 py-0.5 disabled:opacity-30 hover:bg-slate-50"
            >
              <ChevronRight size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>

      {drawerItem && (
        <ItemDetailDrawer
          itemCode={drawerItem}
          targetId={targetId}
          onClose={() => setDrawerItem(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: tsc + lint**

```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -5
```
Expected: 无错误（组件未被引用，tsc 仍编译；lint 无 Error）。

- [ ] **Step 3: Commit**

```bash
git add web/components/report-center/category-item-drawer.tsx
git commit -m "feat(ui): CategoryItemDrawer 品类下钻抽屉（搜索+排序+分页+点行商品详情）"
```

---

### Task 5: CategorySummary 行可点 + 集成 + 删 ItemOutboundList + 接线

**Files:**
- Modify: `web/components/report-center/category-summary.tsx`
- Delete: `web/components/report-center/item-outbound-list.tsx`
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Modify: `web/app/reports/targets/[id]/page.tsx`

**Interfaces:**
- Consumes: `CategoryItemDrawer`（Task 4）；`targetId`（page.tsx 已有）。
- Produces: 品类看板行可点开抽屉；独立出库明细看板移除；page.tsx 不再预取 itemList。

- [ ] **Step 1: category-summary.tsx 加 targetId prop + drawer 状态 + 行可点**

Modify `web/components/report-center/category-summary.tsx`：

import 块（约 line 1-5）加 `useState` 与 `ChevronRight` 与 `CategoryItemDrawer`：
```typescript
import { useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";
import { ChartActions, exportExcel, exportImage } from "./chart-actions";
import { CategoryItemDrawer } from "./category-item-drawer";
```

props interface（约 line 7-10）加 `targetId`：
```typescript
interface CategorySummaryProps {
  rows: CategorySummaryRow[];
  targetMonth: number;
  targetId: number;
}
```

函数签名 + drawer 状态（约 line 27-28）：
```typescript
export function CategorySummary({ rows, targetMonth, targetId }: CategorySummaryProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const [drawerCat, setDrawerCat] = useState<string | null>(null);
```

detail 行（约 line 151-154，`{detailRows.map((r) => (<tr key={r.category} ...>`）改为可点 + 行首 chevron：
```tsx
            {detailRows.map((r) => (
              <tr
                key={r.category}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setDrawerCat(r.category)}
              >
                <td className="px-3 py-2 text-slate-700 font-medium">
                  <span className="inline-flex items-center gap-1">
                    <ChevronRight size={14} strokeWidth={1.5} className="text-slate-400" />
                    {r.category}
                  </span>
                </td>
```
（其余 `<td>` 单元格保持不变；只替换 `<tr>` 开标签与第一个 `<td>` 类别单元格。）

在组件返回 JSX 最外层 `<div>` 闭合前（约 line 232 `</div>` 前）渲染抽屉：
```tsx
      {drawerCat && (
        <CategoryItemDrawer
          targetId={targetId}
          category={drawerCat}
          onClose={() => setDrawerCat(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: 删 item-outbound-list.tsx**

```bash
git rm web/components/report-center/item-outbound-list.tsx
```

- [ ] **Step 3: desktop.tsx 移除 ItemOutboundList + itemList prop + CategorySummary 传 targetId**

Modify `web/app/reports/targets/[id]/desktop.tsx`：

删除 import（约 line 11）：`import { ItemOutboundList } from "@/components/report-center/item-outbound-list";`

类型 import（约 line 17-20）去掉 `ItemOutboundListRow`（itemList prop 将删）：
```typescript
import type {
  ItemBreakdownTop,
} from "@/lib/report-center/item-breakdown";
```

props 解构（约 line 53-56）去掉 `itemList`：
```typescript
  itemTop,
  supplyChain,
  wholesaleDaily,
}: {
```
props 类型（约 line 67-68）去掉 `itemList`：
```typescript
  itemTop: ItemBreakdownTop;
  supplyChain: SupplyChainOutboundRow[];
```

CategorySummary（约 line 136）加 targetId：
```tsx
      <CategorySummary rows={categorySummary} targetMonth={targetMonth} targetId={targetId} />
```

删除 ItemOutboundList 渲染块（约 line 166-171，含注释 `{/* 出库商品明细列表... */}` 整段）：
```tsx
      {/* 出库商品明细列表（类 Excel 交叉表 + 筛选 + 分页） */}
      <ItemOutboundList
        initialRows={itemList.rows}
        initialTotal={itemList.total}
        targetId={targetId}
      />
```
（整段删除。）

- [ ] **Step 4: mobile.tsx 同 desktop 改法**

Modify `web/app/reports/targets/[id]/mobile.tsx`：同样删除 `import { ItemOutboundList }`、类型 import 去 `ItemOutboundListRow`、props 去 `itemList`、CategorySummary 加 `targetId={targetId}`、删除 `<div className="px-4"><ItemOutboundList .../></div>` 整块（约 line 182-189）。

- [ ] **Step 5: page.tsx 移除 itemList 预取 + prop**

Modify `web/app/reports/targets/[id]/page.tsx`：

import（约 line 9-12）改成只留 `getItemBreakdownTop`：
```typescript
import {
  getItemBreakdownTop,
} from "@/lib/report-center/item-breakdown";
```

Promise.all（约 line 42-60）去掉 `itemList`：删掉 `getItemOutboundListPage(targetId, 1, {}),` 行 + 解构里的 `itemList,`。改后 Promise.all 与解构（保留其余 7 项）：
```typescript
  const [
    kpi,
    regionBreakdown,
    categorySummary,
    brandMetric,
    itemTop,
    supplyChain,
    wholesaleDaily,
  ] = await Promise.all([
    getTargetKpi(targetId),
    getRegionBreakdown(id),
    getCategorySummary(id),
    getBrandMetric(targetId),
    getItemBreakdownTop(targetId),
    getSupplyChainOutbound(targetId),
    getWholesaleDaily(targetId),
  ]);
```

`<DesktopDashboard>` 与 `<MobileDashboard>` 调用处（约 line 88-89 与 105-106 附近）去掉 `itemList={itemList}` 行。

- [ ] **Step 6: tsc + lint**

```bash
cd web && npx tsc --noEmit && npm run lint 2>&1 | tail -8
```
Expected: 无错误。重点核对：无 `ItemOutboundList` 残留引用、无 `itemList` 未定义引用、无 `ItemOutboundListRow` 未用 import 报错。

- [ ] **Step 7: Commit**

```bash
git add web/components/report-center/category-summary.tsx web/app/reports/targets/[id]/desktop.tsx web/app/reports/targets/[id]/mobile.tsx web/app/reports/targets/[id]/page.tsx
git add -u web/components/report-center/item-outbound-list.tsx
git commit -m "feat(ui): 品类看板行可点下钻商品明细抽屉 + 删除独立出库商品明细看板"
```

---

### Task 6: controller——GHA 部署 + E2E 验证

> 控制器任务，不派 subagent。依赖 Task 1-5 全部提交。

**Files:** 无（部署 + 验证）

- [ ] **Step 1: push 触发 GHA**

```bash
git push origin main
gh run list --limit 1
```
watch 到 success：
```bash
RUN=$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RUN --exit-status && echo "✅ SUCCESS"
```

- [ ] **Step 2: 部署后 prod 核验（口径）**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT category_group, count(*) items, ROUND(SUM(outbound_amount)) outbound FROM report_item_breakdown_gen WHERE target_id=22 GROUP BY 1 ORDER BY 1;\""
```
Expected: 水果/标品/耗材/其他 四行；水果+标品+耗材 outbound 合计与品类看板 22 的合计同口径。

- [ ] **Step 3: API 核验（category_group 筛选有效）**

```bash
# 模拟抽屉调 item-list 按 category_group=水果 筛
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -s -X POST https://data.shanhaiyiguo.com/api/admin/reports/item-list -H 'Content-Type: application/json' -d '{\"target_id\":22,\"page\":1,\"category\":\"水果\"}' | head -c 300"
```
Expected: `{"ok":true,"rows":[...],"total":<非0>}`，rows 含生鲜类商品（榴莲等）；改 `category` 为 `标品` 返回标品商品。修了原 top_category 筛 0 行的 bug。

- [ ] **Step 4: 企微 E2E（用户验证）**

企微开 `/reports/targets/22`（或当前目标）：品类看板行可点 → 抽屉出该品类商品 → 搜索/排序/分页/点行开商品详情；确认独立「出库商品明细」看板已消失；移动端抽屉近全屏可用。

---

## 验收

| 标准 | 验证 |
|------|------|
| dim_item.category_group 生成列 | Task 1 Step 2 / Task 6 Step 2：粗类分布正确 |
| 商品视图携带 category_group | Task 2 Step 3：生成 SQL 含 `MAX(di.category_group) AS category_group` |
| item-list 按 category_group 筛有效 | Task 6 Step 3：水果/标品 返非0行（修 latent bug） |
| 品类行可点下钻 | Task 6 Step 4：点品类→抽屉出商品 |
| 独立出库明细看板删除 | Task 5 Step 6 tsc 无残留 + 企微页面无该看板 |
| 不改生成器代码 | Task 1 仅改 config extra 裸列；vitest 通过 |

## 风险复盘（spec §风险）

- 生成列非 immutable → Step 2 apply 失败立即暴露（本地先验）。
- dim_item 采集 upsert 冲突 → PostgREST payload 不含 category_group；Task 6 部署后跑一次商品档案采集验证（可选）。
- 仅出库无销售商品 category_group 丢 → 现有 top_category 同行为；下钻按 category_group 与品类看板同口径，可接受。
