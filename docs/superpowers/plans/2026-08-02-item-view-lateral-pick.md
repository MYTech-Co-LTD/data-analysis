# 商品视图 lateral_pick 跨账套回退匹配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修商品视图丢 64188 品品甜批发 4.87M——生成器加 `dim_grain.lateral_pick`，dim join 改 LATERAL 本账套优先+跨品牌回退（LIMIT 1 不翻倍），让品类下钻合计≈品类看板。

**Architecture:** 生成器 tier1.ts dim join 分支：lateral_pick 设则发 `JOIN LATERAL (... WHERE match ORDER BY (prefer_own) DESC LIMIT 1) alias ON true`，否则普通 join（flag 闸控，回归不断）。仅 itemBreakdownView 启用。architecture.md §10.10 已更（铁律先行）。

**Tech Stack:** 语义层生成器（tsx + vitest）、PostgreSQL LATERAL。

**Spec:** `docs/superpowers/specs/2026-08-02-item-view-lateral-pick-design.md`

## Global Constraints

- **铁律**：这是生成器能力扩展（architecture.md §10.10 lateral_pick 条目已更）。flag 闸控，未设 lateral_pick 的视图行为不变（回归测试守护）。
- **不翻倍**：必须 `LIMIT 1` + `ORDER BY (prefer_own) DESC`（item_num 跨品牌重叠 1519 项）。
- **非回归**：3120 自身行本账套优先＝现状；64188 自有商品（货号 2126xxxx）命中 dim_item(64188) 不回退。
- 部署：services/ + database/generated/ + web/（无前端改）→ GHA。gen-views 须 prod 跑后 restart postgrest。

---

## File Structure

- `services/semantic-generator/src/types.ts` — dim_grain 加 lateral_pick 类型
- `services/semantic-generator/src/generators/tier1.ts:304-306` — dim join 分支
- `services/semantic-generator/__tests__/tier1.test.ts` — lateral_pick 发 LATERAL + 回归
- `services/semantic-generator/src/view-configs.ts` — itemBreakdownView.dim_grain 加 lateral_pick
- `database/generated/report_item_breakdown_gen.sql` — 重生成（控制器）

---

### Task 1: 生成器 lateral_pick 能力（types + tier1 + TDD + view-config）

**Files:**
- Modify: `services/semantic-generator/src/types.ts`（dim_grain 加 lateral_pick）
- Modify: `services/semantic-generator/src/generators/tier1.ts:304-306`（dim join 分支）
- Test: `services/semantic-generator/__tests__/tier1.test.ts`
- Modify: `services/semantic-generator/src/view-configs.ts`（itemBreakdownView 启用）

**Interfaces:**
- Produces: `ViewConfig.dim_grain.lateral_pick?: {match; prefer_own}`；生成器对设此 flag 的 view 发 LATERAL join（Task 2 重生成 item 视图依赖）。

- [ ] **Step 1: 写失败测试（lateral_pick 发 LATERAL）**

在 `services/semantic-generator/__tests__/tier1.test.ts` 的 `describe('Tier1 dim_grain', ...)` 块末尾加：
```typescript
  it('lateral_pick 发 LATERAL join（本账套优先+跨品牌回退，LIMIT 1 不翻倍）', () => {
    const config: ViewConfig = {
      view_name: 'test_lateral_pick',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name'],
        lateral_pick: { match: 'item_num = s.item_num', prefer_own: 'system_book_code = s.system_book_code' },
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('JOIN LATERAL');
    expect(sql).toContain('SELECT * FROM dim_item WHERE item_num = s.item_num');
    expect(sql).toContain('ORDER BY (system_book_code = s.system_book_code) DESC');
    expect(sql).toContain('LIMIT 1');
    // 不含旧式精确 join 谓词作主 join
    expect(sql).not.toMatch(/JOIN dim_item di ON di\.system_book_code=s\.system_book_code/);
  });

  it('未设 lateral_pick 时仍发普通 join（回归）', () => {
    const config: ViewConfig = {
      view_name: 'test_no_lateral',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name'],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num');
    expect(sql).not.toContain('JOIN LATERAL');
  });
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd services/semantic-generator && npx vitest run __tests__/tier1.test.ts
```
Expected: 两个新测试 FAIL（lateral_pick 那个不含 LATERAL；回归那个 PASS）。

- [ ] **Step 3: types.ts 加 lateral_pick 类型**

Modify `services/semantic-generator/src/types.ts`，dim_grain 加字段。改后（约 line 72-77 区域）：
```typescript
  dim_grain?: {
    table: string;
    on: string;
    key: string;
    extra?: string[];    // ['item_name','category_name',...]（非分组 dim 列，从 dim 表带出）
    lateral_pick?: { match: string; prefer_own: string };  // 跨账套回退匹配（本账套优先+跨品牌回退，LIMIT 1）
  };
```

- [ ] **Step 4: tier1.ts dim join 分支**

Modify `services/semantic-generator/src/generators/tier1.ts`（约 line 304-306），把：
```typescript
      if (config.dim_grain) {
        joins.push(`JOIN ${config.dim_grain.table} ON ${config.dim_grain.on}`);
      }
```
改为：
```typescript
      if (config.dim_grain) {
        if (config.dim_grain.lateral_pick) {
          // 跨账套回退匹配：本账套优先、跨品牌回退（如 64188 批发卖 3120 货），LIMIT 1 防 item_num 重叠翻倍
          const lpTbl = config.dim_grain.table.split(' ')[0]; // 'dim_item'
          const lpAlias = config.dim_grain.table.split(' ')[1]; // 'di'
          const lp = config.dim_grain.lateral_pick;
          joins.push(`JOIN LATERAL (SELECT * FROM ${lpTbl} WHERE ${lp.match} ORDER BY (${lp.prefer_own}) DESC LIMIT 1) ${lpAlias} ON true`);
        } else {
          joins.push(`JOIN ${config.dim_grain.table} ON ${config.dim_grain.on}`);
        }
      }
```

- [ ] **Step 5: 跑测试确认绿**

```bash
cd services/semantic-generator && npx vitest run __tests__/tier1.test.ts
```
Expected: 全过（含两个新测试）。

- [ ] **Step 6: view-configs itemBreakdownView 启用 lateral_pick**

Modify `services/semantic-generator/src/view-configs.ts` 的 itemBreakdownView.dim_grain（约 line 186-191），加 lateral_pick。改后：
```typescript
  dim_grain: {
    table: 'dim_item di',
    on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
    key: 'item_code',
    extra: ['item_name', 'category_name', 'top_category', 'item_brand', 'category_group'],
    lateral_pick: { match: 'item_num = s.item_num', prefer_own: 'system_book_code = s.system_book_code' },
  },
```

- [ ] **Step 7: tsc + 全量 vitest**

```bash
cd services/semantic-generator && npx tsc --noEmit && npx vitest run
```
Expected: tsc 0 错；vitest 全过。

- [ ] **Step 8: Commit**

```bash
git add services/semantic-generator/src/types.ts services/semantic-generator/src/generators/tier1.ts services/semantic-generator/src/view-configs.ts services/semantic-generator/__tests__/tier1.test.ts
git commit -m "feat(generator): dim_grain.lateral_pick 跨账套回退匹配——修64188批发丢货(本账套优先+跨品牌回退LIMIT1)"
```

---

### Task 2: controller——prod gen-views 重生成 item 视图 + 对账

> 控制器任务，不派 subagent。依赖 Task 1。

**Files:** Modify `database/generated/report_item_breakdown_gen.sql`

- [ ] **Step 1: 隧道 + gen-views（prod 列已就绪，无新迁移）**

```bash
PG_IP=$(ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' deploy-postgres-1")
ssh -i ~/.ssh/ShanHai-OPS.pem -o StrictHostKeyChecking=no -L 15433:${PG_IP}:5432 -N -f root@data.shanhaiyiguo.com
PROD_PW=$(ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker inspect deploy-postgres-1 --format '{{range .Config.Env}}{{println .}}{{end}}'" | grep '^POSTGRES_PASSWORD=' | head -1 | cut -d= -f2-)
cd services/semantic-generator && DATABASE_URL="postgresql://postgres:${PROD_PW}@localhost:15433/insforge" npm run gen-views
```
Expected: 8 视图全生成，EXPLAIN 失败 0（LATERAL join 语法正确，L2 校验过）。

- [ ] **Step 2: 验证产物含 LATERAL + restart postgrest**

```bash
grep -A2 "JOIN LATERAL" database/generated/report_item_breakdown_gen.sql
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
sleep 3
```
Expected: 产物含 `JOIN LATERAL (SELECT * FROM dim_item WHERE item_num = s.item_num ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true`（cte0 + cte1 各一处）。

- [ ] **Step 3: 对账（关键验收）**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT ROUND(SUM(outbound_amount)) item_view_total FROM report_item_breakdown_gen WHERE target_id=22;\""
```
Expected: ≈ 21,242,164（修前 14,460,109）。再核 64188 批发品出现：
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT category_group, count(*) items, ROUND(SUM(outbound_amount)) outbound FROM report_item_breakdown_gen WHERE target_id=22 GROUP BY 1 ORDER BY 1;\""
```
Expected: 水果/标品/耗材 outbound 合计 ≈ 品类看板（水果 16.23M / 标品 4.58M / 耗材 0.43M 量级）。

- [ ] **Step 4: Commit 生成产物**

```bash
git add database/generated/report_item_breakdown_gen.sql
git commit -m "feat(generated): item视图LATERAL跨账套join——64188批发回退3120主档(下钻合计≈品类看板)"
```

---

### Task 3: controller——GHA 部署 + 最终 E2E 对账

> 控制器任务。依赖 Task 1+2。

- [ ] **Step 1: push + watch GHA**

```bash
git push origin main
RUN=$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RUN --exit-status && echo "✅ SUCCESS"
```

- [ ] **Step 2: 部署后 prod 对账 + API 核验**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT ROUND(SUM(outbound_amount)) total FROM report_item_breakdown_gen WHERE target_id=22;\""
```
Expected: ≈ 21.24M。
API 核验（下钻抽屉数据源，category_group 筛）：
```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "curl -s -X POST https://data.shanhaiyiguo.com/api/admin/reports/item-list -H 'Content-Type: application/json' -d '{\"target_id\":22,\"page\":1,\"category\":\"水果\"}' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"total=\",d.get(\"total\"),\"前3=\",[r[\"item_name\"] for r in (d.get(\"rows\") or [])[:3]])'"
```
Expected: total 显著 > 修前 1895（64188 批发榴莲等归入），前3 仍榴莲类。

- [ ] **Step 3: 企微 E2E（用户）**

企微 `/reports/targets/22` 点水果→抽屉商品明细合计 ≈ 品类看板水果单元格（修前差 32%，修后对齐）。标品/耗材同理。

---

## 验收

| 标准 | 验证 |
|------|------|
| lateral_pick 发 LATERAL + LIMIT 1 + ORDER BY prefer_own | Task 1 Step 5 vitest |
| 未设 flag 视图不受影响 | Task 1 Step 5 回归测试 |
| item 视图 outbound ≈ 21.24M（修前 14.46M） | Task 2 Step 3 / Task 3 Step 2 |
| 64188 批发品（榴莲/大虾）归入正确品类 | Task 2 Step 3 |
| 品类下钻抽屉合计 ≈ 品类看板单元格 | Task 3 Step 3 |
| 铁律（architecture.md 先行） | 已更 §10.10 lateral_pick 条目 |

## 风险复盘

- LATERAL 性能 → dim_item.item_num 有索引；EXPLAIN（L2）生成期验证。
- 64188 自有商品错配 3120 → prefer_own 本账套优先（货号 2126xxxx 命中 64188 不回退）。
- 重叠翻倍 → LIMIT 1 + vitest 断言。
- 其它视图回归 → flag 闸控 + 回归测试。
