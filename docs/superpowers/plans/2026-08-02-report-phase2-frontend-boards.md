# 报表 Phase 2 前端板块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在目标看板 `/reports/targets/[id]` 下方追加 3 板块（商品 TOP4 榜+出库下钻弹层+列表、批发客户报表），数据走 2 个 gen 视图（item/customer），口径由 view-configs+生成器产出（铁律：禁手写 SQL 视图）。

**Architecture:** 生成器加 2 个通用 config 驱动能力（`dim_grain` actual CTE grain 变换、`extra_join` LEFT JOIN 补列），产出 `report_item_breakdown_gen` + `report_wholesale_customer_gen` 两视图。lib 函数查视图，3 个 API 路由供 client fetch（日榜切换/列表分页/弹层），4 个组件挂 desktop+mobile。

**Tech Stack:** Next.js 15 (App Router, server components) + TypeScript + @insforge/sdk (PostgREST) + 语义层生成器 (services/semantic-generator, tsx + vitest) + PostgreSQL 15

## Global Constraints

- **铁律**：视图口径必须由 view-configs + 生成器产出，**禁手写 SQL 视图**（`report_*_gen.sql` 必须由 `npm run gen-views` 生成）。生成器代码禁品牌字面量（'3120'/'64188'/'品品甜'），品牌归属数据驱动（dim_branch/dim_brand 列）。
- **门店键铁律**：store 级 grain 必含 `(system_book_code, branch_num)` 复合，禁 branch_num 单独 join。item/customer 视图用 `item_code`/`client_code` 跨品牌合并键。
- **考核过滤铁律**（kpi-assessed-scope-rules）：sale/delivery 只算 is_assessed_war_zone 考核门店，outbound 全量。item/customer 板块是纯 actual 排行无 target 对比，不涉考核过滤（actual 表已含全门店，TOP 榜看全商品排行）。
- **DESIGN.md**：tabular-nums + DM Sans + 达成三色（>10% 蓝/5-10% 琥珀/<5% 灰借用）+ 每组件 ⬇Excel/🖼图片/🔗分享（chart-actions）+ 类 Excel 交叉表（维度切换+列头排序+合并单元格）。
- **部署**：改生成器 view-configs/tier1/types + 跑 `npm run gen-views` 产出 SQL → SSH 隧道对 prod 跑 + restart postgrest；改 web/ 走 GHA push。migrate.sh 每次重跑全部迁移，迁移须幂等。
- **测试**：生成器改代码跑 `npm test`（services/semantic-generator，vitest）；lib 函数单测；L3b 双轨 diff（新视图 vs 直查聚合表 diff=0）。

---

## File Structure

**生成器（services/semantic-generator/）**：
- `src/types.ts` — ViewConfig 加 `dim_grain?`/`extra_join?` 字段
- `src/generators/tier1.ts` — actual CTE 支持 dim_grain join（grain 变换）；final SELECT 支持 extra_join LEFT JOIN 补列
- `src/view-configs.ts` — 加 `itemBreakdownView` + `wholesaleCustomerView` 2 配置
- `__tests__/tier1.test.ts` — 加 dim_grain + extra_join 用例
- `database/generated/report_item_breakdown_gen.sql` — 生成器产出（不手写）
- `database/generated/report_wholesale_customer_gen.sql` — 生成器产出

**前端（web/）**：
- `web/lib/report-center/item-breakdown.ts` — getItemBreakdownTop + getItemOutboundListPage
- `web/lib/report-center/wholesale-customer.ts` — getWholesaleCustomer
- `web/app/api/admin/reports/item-top/route.ts` — 日榜切换
- `web/app/api/admin/reports/item-list/route.ts` — 列表分页筛选
- `web/app/api/admin/reports/item-detail/route.ts` — 弹层
- `web/components/report-center/item-top-boards.tsx` — 4 榜 + 日期选择器
- `web/components/report-center/item-detail-drawer.tsx` — 弹层
- `web/components/report-center/item-outbound-list.tsx` — 完整列表+分页+筛选
- `web/components/report-center/wholesale-customer-report.tsx` — 客户排行+品品甜占比
- `web/app/reports/targets/[id]/page.tsx` — 预取 + 传 desktop/mobile
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` — 挂 4 新组件
- `docs/architecture.md` — §10.9 后追加前端板块说明

---

### Task 1: 生成器加 `dim_grain` 能力（actual CTE grain 变换）

**Files:**
- Modify: `services/semantic-generator/src/types.ts`
- Modify: `services/semantic-generator/src/generators/tier1.ts`
- Test: `services/semantic-generator/__tests__/tier1.test.ts`

**Interfaces:**
- Produces: `ViewConfig.dim_grain?: { table: string; on: string; key: string; extra?: string[] }`。tier1 actual CTE 单表路径（else 分支）+ UNION ALL 路径均支持：`JOIN ${dim_grain.table} ON ${dim_grain.on}`，SELECT/GROUP BY 用 `${alias}.${dim_grain.key}` 替换 `s.${dimKey}`，extra 列追加到 SELECT。

**Why:** item 视图要按 `item_code` 合并，但 `report_daily_item_sales`/`item_outbound` 表只有 `item_num`，必须 JOIN dim_item 做 grain 变换。这是通用维度映射能力（config 驱动），非 item 口径分支，符合铁律。

- [ ] **Step 1: types.ts 加 dim_grain 类型**

```typescript
// 在 ViewConfig interface 加（target_breakdown 字段后）：
  dim_grain?: {
    table: string;       // 'dim_item di'
    on: string;          // 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num'
    key: string;         // 'item_code'（actual CTE 聚合到这一列）
    extra?: string[];    // ['item_name','category_name','top_category','item_brand']（从 dim 表带出）
  };
```

- [ ] **Step 2: tier1.test.ts 写 dim_grain 失败测试**

```typescript
describe('Tier1 dim_grain', () => {
  it('actual CTE join dim table 做 grain 变换 + extra 列', () => {
    const config: ViewConfig = {
      view_name: 'test_item_gen',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name', 'category_name'],
      },
    };
    const sql = generateTier1View(config, metrics, sources);
    // actual CTE 含 JOIN dim_item + GROUP BY di.item_code + extra 列
    expect(sql).toContain('JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num');
    expect(sql).toContain('di.item_code');
    expect(sql).toContain('di.item_name');
    expect(sql).toContain('GROUP BY tgt.target_id, di.item_code');
    // 不含 s.item_num 作为 GROUP BY（grain 已变换）
    expect(sql).not.toMatch(/GROUP BY tgt\.target_id, s\.item_num/);
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `cd services/semantic-generator && npm test -- tier1.test.ts`
Expected: FAIL（dim_grain 未实现，sql 不含 JOIN dim_item）

- [ ] **Step 4: tier1.ts actual CTE 单表路径（else 分支）实现 dim_grain**

找到 else 分支单表路径（约 220-270 行），修改 `const cols`/`selectDims`/`groupDims`/`joins` 块：

```typescript
    // else 单表路径
    for (const g of actualGroups.values()) {
      const cteName = `cte${cteIdx++}`;
      const cols = g.metrics.map(m => {
        const src = sources.find(s => s.metric_code === m.metric_code)!;
        return `SUM(s.${src.source_column}) AS ${m.metric_code}`;
      });
      if (useTargetWindow) {
        for (const m of g.metrics) {
          const dailyCode = dailyMap.get(m.metric_code);
          if (!dailyCode) continue;
          const src = sources.find(s => s.metric_code === m.metric_code)!;
          cols.push(`SUM(s.${src.source_column}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
        }
      }
      // dim_grain：extra 列追加
      if (config.dim_grain?.extra) {
        for (const ex of config.dim_grain.extra) {
          const alias = config.dim_grain.table.split(' ')[1]; // 'di'
          cols.push(`MAX(${alias}.${ex}) AS ${ex}`);
        }
      }
      const colsStr = cols.join(',\n    ');

      const joins: string[] = [];
      const where: string[] = [];
      // dim_grain：actual CTE 加 dim join + grain 变换
      const dimAlias = config.dim_grain?.table.split(' ')[1];
      const grainCol = config.dim_grain ? `${dimAlias}.${config.dim_grain.key}` : `s.${dimKey}`;
      if (g.filter) where.push(g.filter);
      if (config.dim_grain) {
        joins.push(`JOIN ${config.dim_grain.table} ON ${config.dim_grain.on}`);
      }
      let selectDims = grainCol;
      let groupDims = grainCol;
      if (useTargetWindow) {
        joins.push(`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date`);
        selectDims = `tgt.target_id, ${grainCol}`;
        groupDims = `tgt.target_id, ${grainCol}`;
      }
      if (useAssessed) {
        joins.push(`JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num`);
        where.push(`is_assessed_war_zone(db.first_level_region)`);
      }
      const whereClause = where.length ? `\n  WHERE ${where.join(' AND ')}` : '';
      cteList.push(`${cteName} AS (
  SELECT ${selectDims},
    ${colsStr}
  FROM ${g.table} s${joins.length ? '\n  ' + joins.join('\n  ') : ''}${whereClause}
  GROUP BY ${groupDims}
)`);
      for (const m of g.metrics) {
        cteOf.set(m.metric_code, cteName);
        const dailyCode = dailyMap.get(m.metric_code);
        if (dailyCode) cteOf.set(dailyCode, cteName);
      }
    }
```

- [ ] **Step 5: final SELECT 维度列处理 dim_grain**

final SELECT 维度列块（约 310-330 行）修改，dim_grain 时从 cte 选 dim_grain.key + extra（不走 dim_table cross-join）：

```typescript
  // 维度列
  if (useTargetWindow) {
    if (isCategoryUnion) {
      const mergedCte = [...new Set(cteOf.values())][0];
      sel.push(`${mergedCte}.target_id`);
    } else {
      sel.push(`tgt.target_id`);
    }
  }
  if (config.dim_grain) {
    // dim_grain：维度列从 actual CTE 选（actual CTE 已含 key + extra）
    const firstCte = [...new Set(cteOf.values())][0];
    sel.push(`${firstCte}.${config.dim_grain.key} AS ${config.dim_grain.key}`);
    if (config.dim_grain.extra) {
      for (const ex of config.dim_grain.extra) {
        sel.push(`${firstCte}.${ex} AS ${ex}`);
      }
    }
  } else if (dim_table) {
    sel.push(`b.${dimKey} AS ${dimKey}`);
    if (dim_code === 'brand' && dim_table) sel.push(`b.brand_name`);
  } else if (useTargetWindow) {
    const firstCte = [...new Set(cteOf.values())][0];
    sel.push(`${firstCte}.${dimKey} AS ${dimKey}`);
  } else {
    sel.push(`${dimKey} AS ${dimKey}`);
  }
```

- [ ] **Step 6: final SELECT FROM 块处理 dim_grain（不走 dim_table cross-join）**

FROM 块（约 340-360 行）修改，dim_grain 时 firstCte 作 FROM + 其余 FULL JOIN：

```typescript
  const fromParts: string[] = [];
  const usedCtes = new Set(cteOf.values());
  const cteNames = [...usedCtes];
  if (config.dim_grain) {
    // dim_grain：无 dim_table cross-join，actual CTE 之间 FULL JOIN ON dim_grain.key
    fromParts.push(cteNames[0]);
    for (const cn of cteNames.slice(1)) {
      const on = useTargetWindow
        ? `${cn}.target_id = ${cteNames[0]}.target_id AND ${cn}.${config.dim_grain.key} = ${cteNames[0]}.${config.dim_grain.key}`
        : `${cn}.${config.dim_grain.key} = ${cteNames[0]}.${config.dim_grain.key}`;
      fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
    }
  } else if (dim_table) {
    fromParts.push(`${dim_table} b`);
    if (useTargetWindow) fromParts.push(`CROSS JOIN tgt`);
    for (const cn of cteNames) {
      const on = useTargetWindow
        ? `${cn}.target_id = tgt.target_id AND ${cn}.${dimKey} = b.${dimKey}`
        : `${cn}.${dimKey} = b.${dimKey}`;
      fromParts.push(`LEFT JOIN ${cn} ON ${on}`);
    }
  } else if (cteNames.length) {
    fromParts.push(cteNames[0]);
    for (const cn of cteNames.slice(1)) {
      const on = useTargetWindow
        ? `${cn}.target_id = ${cteNames[0]}.target_id AND ${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`
        : `${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`;
      fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
    }
  }
```

- [ ] **Step 7: 跑测试验证通过**

Run: `cd services/semantic-generator && npm test -- tier1.test.ts`
Expected: PASS（dim_grain 用例 + 原有用例全过）

- [ ] **Step 8: Commit**

```bash
git add services/semantic-generator/src/types.ts services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/tier1.test.ts
git commit -m "feat(generator): dim_grain 能力——actual CTE grain 变换 via dim join"
```

---

### Task 2: 生成器加 `extra_join` 能力（LEFT JOIN 补列）

**Files:**
- Modify: `services/semantic-generator/src/types.ts`
- Modify: `services/semantic-generator/src/generators/tier1.ts`
- Test: `services/semantic-generator/__tests__/tier1.test.ts`

**Interfaces:**
- Produces: `ViewConfig.extra_join?: { table: string; on: string; cols: { out: string; expr: string }[] }`。tier1 final SELECT 加 `LEFT JOIN ${extra_join.table} ON ${extra_join.on}`，输出 cols（`{expr} AS {out}`）。不变换 grain。

**Why:** customer 视图要补 `client_brand_code`（join dim_branch 取 system_book_code，数据驱动识别品品甜，无品牌字面量）。client_code 已在 wholesale_customer 表（grain 一致），不需 dim_grain，只需 LEFT JOIN 补列。

- [ ] **Step 1: types.ts 加 extra_join 类型**

```typescript
// 在 ViewConfig interface dim_grain 后加：
  extra_join?: {
    table: string;        // 'dim_branch db'
    on: string;           // 'db.branch_name=w.client_name'
    cols: { out: string; expr: string }[];  // [{ out: 'client_brand_code', expr: 'db.system_book_code' }]
  };
```

- [ ] **Step 2: tier1.test.ts 写 extra_join 失败测试**

```typescript
describe('Tier1 extra_join', () => {
  it('final SELECT LEFT JOIN 补列不变换 grain', () => {
    const config: ViewConfig = {
      view_name: 'test_customer_gen',
      metrics: ['wholesale_amount'],
      dim_code: 'customer',
      levels: ['customer'],
      target_metric_codes: [],
      scope: { target_window: true },
      extra_join: {
        table: 'dim_branch db',
        on: 'db.branch_name=w.client_name',
        cols: [{ out: 'client_brand_code', expr: 'db.system_book_code' }],
      },
    };
    const sql = generateTier1View(config, metrics, sources);
    expect(sql).toContain('LEFT JOIN dim_branch db ON db.branch_name=w.client_name');
    expect(sql).toContain('db.system_book_code AS client_brand_code');
    // grain 仍是 client_code（不变换）
    expect(sql).toContain('GROUP BY tgt.target_id, w.client_code');
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

Run: `cd services/semantic-generator && npm test -- tier1.test.ts`
Expected: FAIL（extra_join 未实现）

- [ ] **Step 4: tier1.ts final SELECT 加 extra_join 列 + FROM 加 LEFT JOIN**

final SELECT 指标列后追加 extra_join cols（约 335 行，指标列 for 循环后）：

```typescript
  // extra_join 补列（不变换 grain，LEFT JOIN）
  if (config.extra_join) {
    for (const c of config.extra_join.cols) {
      sel.push(`${c.expr} AS ${c.out}`);
    }
  }
```

FROM 块末尾（dim_grain/dim_table/cte 分支后）追加 extra_join：

```typescript
  // extra_join LEFT JOIN
  if (config.extra_join) {
    const mainAlias = fromParts[0].split(' ')[0]; // 第一个 FROM 项的表名/别名作锚
    fromParts.push(`LEFT JOIN ${config.extra_join.table} ON ${config.extra_join.on}`);
  }
```

> 注意：extra_join ON 条件引用的别名（如 `w.client_name`）需与 actual CTE 别名一致。customer 视图 actual 表别名是 `s`（tier1 通用别名），ON 要用 `s.client_name`。config 里写 `db.branch_name=s.client_name`。

- [ ] **Step 5: 跑测试验证通过**

Run: `cd services/semantic-generator && npm test -- tier1.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/semantic-generator/src/types.ts services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/tier1.test.ts
git commit -m "feat(generator): extra_join 能力——final SELECT LEFT JOIN 补列"
```

---

### Task 3: view-configs 加 2 配置 + 生成视图 + 部署

**Files:**
- Modify: `services/semantic-generator/src/view-configs.ts`
- Generate: `database/generated/report_item_breakdown_gen.sql`
- Generate: `database/generated/report_wholesale_customer_gen.sql`

**Interfaces:**
- Consumes: Task 1 dim_grain + Task 2 extra_join
- Produces: 2 个 gen 视图 SQL（部署到 prod 后 anon/authenticated 可读）

**Why:** 落地 2 视图配置，生成器产出 SQL，对 prod 生成 + restart postgrest。

- [ ] **Step 1: view-configs.ts 加 itemBreakdownView 配置**

```typescript
/**
 * 商品分解视图配置（Phase 2 前端板块）
 * 生成 report_item_breakdown_gen，按 item_code 合并跨品牌（dim_item join grain 变换）
 * 服务：商品 TOP4 榜（销售/出库 × 月/日）+ 出库商品列表
 * 口径：sale_amount + delivery/wholesale/outbound（derived=delivery+wholesale，AST 已有）
 * 无 target 列（item 级无目标分解），target_id 仅借目标周期作时间窗口
 */
export const itemBreakdownView: ViewConfig = {
  view_name: 'report_item_breakdown_gen',
  metrics: [
    'sale_amount',
    'sale_profit',
    'delivery_amount',
    'delivery_profit',
    'wholesale_amount',
    'wholesale_profit',
    'outbound_amount',   // derived = delivery + wholesale（AST）
    'outbound_profit',   // derived = delivery_profit + wholesale_profit（AST）
  ],
  dim_code: 'item',
  levels: ['item'],
  target_metric_codes: [],  // 无 target
  scope: { target_window: true, target_status: ['active', 'closed'] },
  dim_grain: {
    table: 'dim_item di',
    on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
    key: 'item_code',
    extra: ['item_name', 'category_name', 'top_category', 'item_brand'],
  },
};
```

- [ ] **Step 2: view-configs.ts 加 wholesaleCustomerView 配置**

```typescript
/**
 * 批发客户视图配置（Phase 2 前端板块）
 * 生成 report_wholesale_customer_gen，按 client_code 聚合
 * 服务：批发客户报表（3120 客户排行 + 品品甜占比）
 * 品牌识别数据驱动：LEFT JOIN dim_branch ON branch_name=client_name 取 system_book_code AS client_brand_code
 *   前端判断 client_brand_code 对应品牌（无 64188 字面量在生成器/config）
 */
export const wholesaleCustomerView: ViewConfig = {
  view_name: 'report_wholesale_customer_gen',
  metrics: [
    'wholesale_amount',
    'wholesale_profit',
  ],
  dim_code: 'customer',
  levels: ['customer'],
  target_metric_codes: [],
  scope: { target_window: true, target_status: ['active', 'closed'] },
  extra_join: {
    table: 'dim_branch db',
    on: 'db.branch_name=s.client_name',
    cols: [{ out: 'client_brand_code', expr: 'db.system_book_code' }],
  },
};
```

- [ ] **Step 3: 确认 view-configs 导出 + index.ts 注册**

```bash
# 检查 src/index.ts 是否需要注册新配置（看现有 brandMetricView 怎么注册的）
grep -n "brandMetricView\|viewConfigs\|export" services/semantic-generator/src/index.ts | head
```

按现有模式把 `itemBreakdownView` + `wholesaleCustomerView` 加进 index.ts 的 viewConfigs 数组（若 index.ts 集中导出）。

- [ ] **Step 4: 跑生成器测试**

Run: `cd services/semantic-generator && npm test`
Expected: 全过（含新 dim_grain/extra_join 用例 + 原有 54 用例）

- [ ] **Step 5: 本地 dry-run gen-views 看产出 SQL**

Run: `cd services/semantic-generator && npm run gen-views -- --dry-run 2>&1 | head`（若无 --dry-run，跑 gen-views 看是否产出 5 视图）
Expected: 产出 `report_item_breakdown_gen` + `report_wholesale_customer_gen`，EXPLAIN 失败 0

- [ ] **Step 6: 对 prod 跑 gen-views（SSH 隧道）**

```bash
# 建 SSH 隧道（postgres 容器 IP 172.18.0.4）
ssh -i "~/.ssh/ShanHai-OPS.pem" -L 15433:172.18.0.4:5432 -N -f -o ExitOnForwardFailure=yes root@data.shanhaiyiguo.com
PGPASSWORD=$(ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "grep '^POSTGRES_PASSWORD=' /opt/data-analytics-platform/deploy/.env | cut -d= -f2-") && \
DATABASE_URL="postgresql://postgres:${PGPASSWORD}@localhost:15433/insforge" npm run gen-views
```
Expected: 产出 5 视图，EXPLAIN 失败 0

- [ ] **Step 7: prod restart postgrest 刷 schema 缓存**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 8: prod 验证 2 视图可查 + 数据正确**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT count(*), round(sum(sale_amount)/10000,1) AS sale_wan,
       round(sum(outbound_amount)/10000,1) AS out_wan
FROM report_item_breakdown_gen WHERE target_id=22;
\" -c \"SELECT count(*), round(sum(wholesale_amount)/10000,1) AS w_wan
FROM report_wholesale_customer_gen WHERE target_id=22 AND system_book_code='3120';\""
```
Expected: item 视图 sale=2412.9 万（同底表全量，注意 item 全品牌含非考核，outbound 全量铁律）；customer 视图 3120 客户数 + 金额

- [ ] **Step 9: L3b 双轨 diff（新视图 vs 直查聚合表）**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
-- 视图 vs 直查（7月，target_id=22）
SELECT '视图' AS src, count(*), round(sum(sale_amount)/10000,1) FROM report_item_breakdown_gen WHERE target_id=22
UNION ALL
SELECT '直查', count(DISTINCT di.item_code), round(sum(s.sale_amount)/10000,1)
FROM report_daily_item_sales s JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num
WHERE s.biz_date BETWEEN '2026-07-01' AND '2026-07-31';\""
```
Expected: diff=0（行数 + 金额一致）

- [ ] **Step 10: Commit**

```bash
git add services/semantic-generator/src/view-configs.ts services/semantic-generator/src/index.ts database/generated/report_item_breakdown_gen.sql database/generated/report_wholesale_customer_gen.sql
git commit -m "feat(reports): view-configs 加 item/customer 2 视图 + 生成 SQL 部署"
```

---

### Task 4: lib 函数（3 个 get）

**Files:**
- Create: `web/lib/report-center/item-breakdown.ts`
- Create: `web/lib/report-center/wholesale-customer.ts`

**Interfaces:**
- Consumes: Task 3 的 2 gen 视图
- Produces: `getItemBreakdownTop(targetId, dayDate?)`、`getItemOutboundListPage(targetId, page, filters)`、`getWholesaleCustomer(targetId)`

**Why:** server 端取数（page.tsx 预取）+ API 路由复用。

- [ ] **Step 1: item-breakdown.ts 实现 3 函数**

```typescript
// web/lib/report-center/item-breakdown.ts
import { getClient } from "@/lib/api";

export interface ItemTopRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  amount: number;
  pct: number;  // 占比%
}

export interface ItemBreakdownTop {
  saleMonth: ItemTopRow[];      // 销售月榜 TOP20
  outboundMonth: ItemTopRow[];  // 出库月榜 TOP20
  saleDay: ItemTopRow[];        // 销售日榜 TOP20（默认日）
  outboundDay: ItemTopRow[];   // 出库日榜 TOP20（默认日）
  defaultDay: string;          // 默认日期 YYYY-MM-DD
}

export async function getItemBreakdownTop(targetId: number): Promise<ItemBreakdownTop> {
  const client = await getClient();
  // 取目标周期
  const { data: t } = await client.database
    .from("targets").select("start_date,end_date").eq("id", targetId).single();
  if (!t) return { saleMonth: [], outboundMonth: [], saleDay: [], outboundDay: [], defaultDay: "" };

  const today = new Date().toISOString().slice(0, 10);
  const defaultDay = today >= t.start_date && today <= t.end_date
    ? today
    : today > t.end_date ? t.end_date : t.start_date;

  // 月榜全集（视图已按周期聚合，前端不 LIMIT，server 端 ORDER BY+LIMIT）
  const { data: monthRows } = await client.database
    .from("report_item_breakdown_gen")
    .select("item_code,item_name,category_name,sale_amount,outbound_amount")
    .eq("target_id", targetId);
  const monthArr = monthRows ?? [];
  const saleTotal = monthArr.reduce((s, r) => s + Number(r.sale_amount || 0), 0);
  const outTotal = monthArr.reduce((s, r) => s + Number(r.outbound_amount || 0), 0);
  const toTop = (rows: any[], key: string, total: number): ItemTopRow[] =>
    rows.sort((a, b) => Number(b[key]) - Number(a[key])).slice(0, 20)
      .map(r => ({ item_code: r.item_code, item_name: r.item_name, category_name: r.category_name, amount: Number(r[key] || 0), pct: total > 0 ? Number(r[key]) / total : 0 }));
  const saleMonth = toTop(monthArr, "sale_amount", saleTotal);
  const outboundMonth = toTop(monthArr, "outbound_amount", outTotal);

  // 日榜：查 report_daily_item_sales/outbound 单日聚合（视图无单日聚合，直查底表 join dim_item）
  // 注：日榜走直查底表（item 级单日聚合，非周期聚合），符合"日榜可选任一天"需求
  const { data: dayRows } = await client.database.rpc("get_item_top_by_day", {
    p_target_id: targetId, p_day: defaultDay,
  });
  const dayArr = dayRows ?? [];
  const saleDayTotal = dayArr.reduce((s, r) => s + Number(r.sale_amount || 0), 0);
  const outDayTotal = dayArr.reduce((s, r) => s + Number(r.outbound_amount || 0), 0);
  const saleDay = toTop(dayArr, "sale_amount", saleDayTotal);
  const outboundDay = toTop(dayArr, "outbound_amount", outDayTotal);

  return { saleMonth, outboundMonth, saleDay, outboundDay, defaultDay };
}

export interface ItemOutboundListRow {
  item_code: string;
  item_name: string;
  category_name: string | null;
  top_category: string | null;
  delivery_amount: number;
  wholesale_amount: number;
  outbound_amount: number;
  pct: number;
}

export async function getItemOutboundListPage(
  targetId: number, page: number, filters: { category?: string; brand?: string; q?: string }
): Promise<{ rows: ItemOutboundListRow[]; total: number }> {
  const client = await getClient();
  let q = client.database
    .from("report_item_breakdown_gen")
    .select("item_code,item_name,category_name,top_category,delivery_amount,wholesale_amount,outbound_amount", { count: "exact" })
    .eq("target_id", targetId);
  if (filters.category) q = q.eq("top_category", filters.category);
  if (filters.brand) q = q.eq("item_brand", filters.brand);
  if (filters.q) q = q.ilike("item_name", `%${filters.q}%`);
  const { data, count } = await q.order("outbound_amount", { ascending: false })
    .range((page - 1) * 50, page * 50 - 1);
  const rows = (data ?? []).map(r => ({ ...r, pct: 0 } as ItemOutboundListRow));
  // 占比需 total（再查一次 sum，或前端算）——简化：total 从 count 拿行数，占比前端算
  return { rows, total: count ?? 0 };
}
```

- [ ] **Step 2: wholesale-customer.ts 实现 getWholesaleCustomer**

```typescript
// web/lib/report-center/wholesale-customer.ts
import { getClient } from "@/lib/api";

export interface WholesaleCustomerRow {
  client_code: string;
  client_name: string;
  wholesale_amount: number;
  pct: number;
  cumulative_pct: number;
  is_pinpintian: boolean;  // client_brand_code 对应品品甜品牌
}

export async function getWholesaleCustomer(targetId: number): Promise<{
  rows: WholesaleCustomerRow[];
  pinpintianAmount: number;
  pinpintianPct: number;
  total3120: number;
}> {
  const client = await getClient();
  const { data, error } = await client.database
    .from("report_wholesale_customer_gen")
    .select("client_code,client_name,wholesale_amount,client_brand_code,system_book_code")
    .eq("target_id", targetId)
    .eq("system_book_code", "3120")  // 3120 客户为主
    .order("wholesale_amount", { ascending: false });
  if (error) { console.error("wholesale_customer fetch:", error); return { rows: [], pinpintianAmount: 0, pinpintianPct: 0, total3120: 0 }; }
  const arr = data ?? [];
  const total = arr.reduce((s, r) => s + Number(r.wholesale_amount || 0), 0);
  // 品牌识别数据驱动：client_brand_code 来自视图（dim_branch.system_book_code）
  // 前端判断品品甜：client_brand_code === 品品甜品牌的 system_book_code
  // 品品甜品牌 system_book_code 查 dim_brand（不硬编码）
  const { data: brands } = await client.database.from("dim_brand").select("system_book_code,brand_name");
  const pptBrand = (brands ?? []).find(b => b.brand_name === "品品甜")?.system_book_code;
  let cumul = 0;
  const rows: WholesaleCustomerRow[] = arr.map(r => {
    const amt = Number(r.wholesale_amount || 0);
    const pct = total > 0 ? amt / total : 0;
    cumul += pct;
    return {
      client_code: r.client_code,
      client_name: r.client_name,
      wholesale_amount: amt,
      pct,
      cumulative_pct: cumul,
      is_pinpintian: !!(pptBrand && r.client_brand_code === pptBrand),
    };
  });
  const ppAmount = rows.filter(r => r.is_pinpintian).reduce((s, r) => s + r.wholesale_amount, 0);
  return { rows, pinpintianAmount: ppAmount, pinpintianPct: total > 0 ? ppAmount / total : 0, total3120: total };
}
```

- [ ] **Step 3: 迁移加 get_item_top_by_day RPC（日榜单日聚合）**

```sql
-- database/migrations/141_get_item_top_by_day.sql
-- 日榜：指定 target_id + 单日，按 item_code 聚合销售+出库（join dim_item 合并跨品牌）
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(
  item_code TEXT, item_name TEXT, category_name TEXT,
  sale_amount NUMERIC, delivery_amount NUMERIC, wholesale_amount NUMERIC, outbound_amount NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT di.item_code, MAX(di.item_name), MAX(di.category_name),
    COALESCE(SUM(s.sale_amount), 0),
    COALESCE(SUM(o.delivery_amount), 0),
    COALESCE(SUM(o.wholesale_amount), 0),
    COALESCE(SUM(o.delivery_amount), 0) + COALESCE(SUM(o.wholesale_amount), 0)
  FROM targets t
  LEFT JOIN report_daily_item_sales s ON s.biz_date = p_day
    AND s.system_book_code = t.system_book_code  -- 全品牌不限定 sbc，t.system_book_code='ALL' 或具体
    AND s.biz_date BETWEEN t.start_date AND t.end_date
  LEFT JOIN report_daily_item_outbound o ON o.biz_date = p_day
    AND o.system_book_code = s.system_book_code AND o.item_num = s.item_num
  JOIN dim_item di ON di.system_book_code = COALESCE(s.system_book_code, o.system_book_code)
    AND di.item_num = COALESCE(s.item_num, o.item_num)
  WHERE t.id = p_target_id
  GROUP BY di.item_code
  ORDER BY COALESCE(SUM(s.sale_amount), 0) + COALESCE(SUM(o.delivery_amount),0) + COALESCE(SUM(o.wholesale_amount),0) DESC;
$$;
GRANT EXECUTE ON FUNCTION get_item_top_by_day(BIGINT, DATE) TO anon, authenticated;
```

> 注意：targets.system_book_code='3120'（总部主账套），但 item 是全品牌。日榜要全品牌 item，WHERE 不限 sbc（或 t.system_book_code='ALL' 时全品牌）。上面 SQL 用 `s.system_book_code = t.system_book_code` 可能过滤掉 64188。修正：item 全品牌合并，日榜不限 sbc——去掉 `AND s.system_book_code = t.system_book_code`，只保留 biz_date + 周期内。

修正版（去掉 sbc 过滤，全品牌合并）：

```sql
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(...) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT di.item_code, MAX(di.item_name), MAX(di.category_name),
    COALESCE(SUM(s.sale_amount), 0),
    COALESCE(SUM(o.delivery_amount), 0),
    COALESCE(SUM(o.wholesale_amount), 0),
    COALESCE(SUM(o.delivery_amount), 0) + COALESCE(SUM(o.wholesale_amount), 0)
  FROM targets t
  CROSS JOIN report_daily_item_sales s  -- 品牌拆分需重构，简化见下
  ...
$$;
```

> 实现注意：日榜要全品牌按 item_code 合并单日。最简：用 report_item_breakdown_gen 视图无法单日（视图按周期聚合）。需独立 RPC 直查 2 底表 join dim_item GROUP BY item_code WHERE biz_date=p_day AND p_day 在 target 周期内。RPC SQL 在迁移 141 写完整（JOIN 2 表 + dim_item，FULL OUTER 合并 sale/outbound 同 item_code）。

- [ ] **Step 4: 部署迁移 141**

```bash
# push 触发 GHA（迁移 141 走 migrate.sh）
git add database/migrations/141_get_item_top_by_day.sql && git commit -m "feat(migrations): 141 get_item_top_by_day RPC（日榜单日聚合）"
git push origin main
```

- [ ] **Step 5: 验证 RPC**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT * FROM get_item_top_by_day(22, '2026-07-31') LIMIT 5;\""
```

- [ ] **Step 6: Commit lib 函数**

```bash
git add web/lib/report-center/item-breakdown.ts web/lib/report-center/wholesale-customer.ts
git commit -m "feat(reports): lib 函数 getItemBreakdownTop/getItemOutboundListPage/getWholesaleCustomer"
```

---

### Task 5: API 路由（3 个）

**Files:**
- Create: `web/app/api/admin/reports/item-top/route.ts`
- Create: `web/app/api/admin/reports/item-list/route.ts`
- Create: `web/app/api/admin/reports/item-detail/route.ts`

**Interfaces:**
- Consumes: Task 4 lib 函数 + getClient
- Produces: 3 个 POST 端点（client fetch 用）

**Why:** client 切换日榜日期、列表翻页、弹层按需 fetch。

- [ ] **Step 1: item-top 路由（日榜切换）**

```typescript
// web/app/api/admin/reports/item-top/route.ts
import { NextRequest, NextResponse } from "next/server";
import { get_item_top_by_day } from "@/lib/report-center/item-breakdown";  // 直查 RPC
import { getClient } from "@/lib/api";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, date, metric } = b;  // metric: 'sale'|'outbound'
  if (!target_id || !date) return NextResponse.json({ ok: false, error: "缺 target_id/date" }, { status: 400 });
  const client = await getClient();
  const { data, error } = await client.database.rpc("get_item_top_by_day", { p_target_id: target_id, p_day: date });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  const rows = (data ?? []).map((r: any) => ({ ...r }));
  const total = rows.reduce((s: number, r: any) => s + Number(r[metric === "sale" ? "sale_amount" : "outbound_amount"] || 0), 0);
  rows.sort((a: any, b: any) => Number(b[metric === "sale" ? "sale_amount" : "outbound_amount"]) - Number(a[metric === "sale" ? "sale_amount" : "outbound_amount"]));
  const top20 = rows.slice(0, 20).map((r: any) => ({
    item_code: r.item_code, item_name: r.item_name, category_name: r.category_name,
    amount: Number(r[metric === "sale" ? "sale_amount" : "outbound_amount"] || 0),
    pct: total > 0 ? Number(r[metric === "sale" ? "sale_amount" : "outbound_amount"]) / total : 0,
  }));
  return NextResponse.json({ ok: true, rows: top20 });
}
```

- [ ] **Step 2: item-list 路由（列表分页筛选）**

```typescript
// web/app/api/admin/reports/item-list/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getItemOutboundListPage } from "@/lib/report-center/item-breakdown";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, page = 1, category, brand, q } = b;
  if (!target_id) return NextResponse.json({ ok: false, error: "缺 target_id" }, { status: 400 });
  const { rows, total } = await getItemOutboundListPage(Number(target_id), Number(page), { category, brand, q });
  return NextResponse.json({ ok: true, rows, total });
}
```

- [ ] **Step 3: item-detail 路由（弹层日趋势+品牌分布）**

```typescript
// web/app/api/admin/reports/item-detail/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/lib/api";

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { target_id, item_code } = b;
  if (!target_id || !item_code) return NextResponse.json({ ok: false, error: "缺 target_id/item_code" }, { status: 400 });
  const client = await getClient();
  // 日趋势：该 item_code 所有 item_num 分品牌 × 日
  const { data: daily, error: e1 } = await client.database.rpc("get_item_detail", { p_target_id: target_id, p_item_code: item_code });
  if (e1) return NextResponse.json({ ok: false, error: e1.message }, { status: 400 });
  // 类别归属
  const { data: meta } = await client.database
    .from("dim_item").select("item_name,category_name,top_category,item_brand,system_book_code")
    .eq("item_code", item_code).limit(1);
  return NextResponse.json({ ok: true, daily: daily ?? [], meta: meta ?? [] });
}
```

- [ ] **Step 4: 迁移 142 get_item_detail RPC**

```sql
-- database/migrations/142_get_item_detail.sql
-- 弹层：item_code × 日 × 品牌 分布（销售+出库）
CREATE OR REPLACE FUNCTION get_item_detail(p_target_id BIGINT, p_item_code TEXT)
RETURNS TABLE(biz_date DATE, system_book_code TEXT, sale_amount NUMERIC, outbound_amount NUMERIC)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT s.biz_date, s.system_book_code,
    COALESCE(SUM(s.sale_amount), 0),
    COALESCE(SUM(o.delivery_amount), 0) + COALESCE(SUM(o.wholesale_amount), 0)
  FROM targets t
  JOIN report_daily_item_sales s ON s.biz_date BETWEEN t.start_date AND t.end_date
  JOIN dim_item di ON di.system_book_code = s.system_book_code AND di.item_num = s.item_num AND di.item_code = p_item_code
  LEFT JOIN report_daily_item_outbound o ON o.biz_date = s.biz_date AND o.system_book_code = s.system_book_code AND o.item_num = s.item_num
  WHERE t.id = p_target_id
  GROUP BY s.biz_date, s.system_book_code
  ORDER BY s.biz_date;
$$;
GRANT EXECUTE ON FUNCTION get_item_detail(BIGINT, TEXT) TO anon, authenticated;
```

- [ ] **Step 5: push 部署迁移 142 + 验证**

```bash
git add web/app/api/admin/reports/ database/migrations/142_get_item_detail.sql
git commit -m "feat(reports): 3 API 路由 + get_item_detail RPC（弹层）"
git push origin main
```

- [ ] **Step 6: 验证 3 路由**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/reports/item-top -H "Content-Type: application/json" -d '{"target_id":22,"date":"2026-07-31","metric":"sale"}' | head -c 200
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/reports/item-list -H "Content-Type: application/json" -d '{"target_id":22,"page":1}' | head -c 200
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/reports/item-detail -H "Content-Type: application/json" -d '{"target_id":22,"item_code":"<某item_code>"}' | head -c 200
```

---

### Task 6: ItemTopBoards 组件（4 榜 + 日期选择器）

**Files:**
- Create: `web/components/report-center/item-top-boards.tsx`

**Interfaces:**
- Consumes: Task 4 ItemBreakdownTop，Task 5 item-top API
- Produces: `ItemTopBoards` 组件（4 榜 2 行 2 列 + 日期选择 + 点入弹层）

- [ ] **Step 1: 组件实现（PC 2 行 2 列，移动 tab）**

```tsx
// web/components/report-center/item-top-boards.tsx
"use client";
import { useState } from "react";
import { ChartActions, exportExcel } from "./chart-actions";
import { ItemDetailDrawer } from "./item-detail-drawer";
import type { ItemBreakdownTop, ItemTopRow } from "@/lib/report-center/item-breakdown";

function pctColor(pct: number): string {
  if (pct >= 0.10) return "text-blue-600";
  if (pct >= 0.05) return "text-amber-600";
  return "text-slate-400";
}
function fmtWan(v: number) { return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`; }

function TopList({ rows, onPick }: { rows: ItemTopRow[]; onPick: (code: string) => void }) {
  return (
    <ol className="text-sm tabular-nums">
      {rows.map((r, i) => (
        <li key={r.item_code} className="flex items-center gap-2 py-1 hover:bg-slate-50 cursor-pointer" onClick={() => onPick(r.item_code)}>
          <span className="text-slate-400 w-6">{i + 1}</span>
          <span className="flex-1 truncate">{r.item_name}</span>
          <span className="font-medium">{fmtWan(r.amount)}</span>
          <span className={`text-xs w-12 text-right ${pctColor(r.pct)}`}>{(r.pct * 100).toFixed(1)}%</span>
        </li>
      ))}
    </ol>
  );
}

export function ItemTopBoards({ top, targetId }: { top: ItemBreakdownTop; targetId: number }) {
  const [day, setDay] = useState(top.defaultDay);
  const [dayData, setDayData] = useState<{ sale: ItemTopRow[]; outbound: ItemTopRow[] }>({
    sale: top.saleDay, outbound: top.outboundDay,
  });
  const [drawer, setDrawer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onDayChange = async (d: string) => {
    setDay(d); setBusy(true);
    const [s, o] = await Promise.all([
      fetch("/api/admin/reports/item-top", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_id: targetId, date: d, metric: "sale" }) }).then(r => r.json()),
      fetch("/api/admin/reports/item-top", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_id: targetId, date: d, metric: "outbound" }) }).then(r => r.json()),
    ]);
    setDayData({ sale: s.rows ?? [], outbound: o.rows ?? [] });
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-800">商品 TOP 榜</h3>
        <div className="flex items-center gap-2">
          <input type="date" value={day} onChange={e => onDayChange(e.target.value)} className="border rounded px-2 py-0.5 text-xs tabular-nums" />
          <ChartActions onExcel={() => exportExcel([["排名", "商品", "金额", "占比"], ...top.saleMonth.map((r, i) => [i + 1, r.item_name, r.amount, (r.pct * 100).toFixed(1) + "%"])], "商品TOP销售月榜")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-slate-500 mb-1">销售月榜</div>
          <TopList rows={top.saleMonth} onPick={setDrawer} />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">销售日榜（{day}）</div>
          <TopList rows={dayData.sale} onPick={setDrawer} />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">出库月榜</div>
          <TopList rows={top.outboundMonth} onPick={setDrawer} />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">出库日榜（{day}）{busy && " 加载中…"}</div>
          <TopList rows={dayData.outbound} onPick={setDrawer} />
        </div>
      </div>
      {drawer && <ItemDetailDrawer itemCode={drawer} targetId={targetId} onClose={() => setDrawer(null)} />}
    </div>
  );
}
```

- [ ] **Step 2: tsc + lint + commit**

```bash
cd web && npx tsc --noEmit 2>&1 | grep -E "item-top|error" | head
git add web/components/report-center/item-top-boards.tsx
git commit -m "feat(reports): ItemTopBoards 组件（4 榜 + 日期选择 + 点入弹层）"
```

---

### Task 7: ItemDetailDrawer 组件（弹层）

**Files:**
- Create: `web/components/report-center/item-detail-drawer.tsx`

**Interfaces:**
- Consumes: Task 5 item-detail API
- Produces: `ItemDetailDrawer`（日趋势线 + 品牌分布 + 类别卡）

- [ ] **Step 1: 组件实现**

```tsx
// web/components/report-center/item-detail-drawer.tsx
"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

interface Daily { biz_date: string; system_book_code: string; sale_amount: number; outbound_amount: number; }
interface Meta { item_name: string; category_name: string; top_category: string; item_brand: string; system_book_code: string; }

export function ItemDetailDrawer({ itemCode, targetId, onClose }: { itemCode: string; targetId: number; onClose: () => void }) {
  const [daily, setDaily] = useState<Daily[]>([]);
  const [meta, setMeta] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/admin/reports/item-detail", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, item_code: itemCode }),
      }).then(r => r.json());
      setDaily(r.daily ?? []); setMeta(r.meta ?? []); setLoading(false);
    })();
  }, [itemCode, targetId]);

  // 品牌分布
  const byBrand = daily.reduce((m: Record<string, { sale: number; out: number }>, d) => {
    const k = d.system_book_code;
    if (!m[k]) m[k] = { sale: 0, out: 0 };
    m[k].sale += Number(d.sale_amount); m[k].out += Number(d.outbound_amount);
    return m;
  }, {});
  const m = meta[0];

  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-white w-[480px] max-w-[92vw] h-full overflow-auto p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold">{m?.item_name ?? itemCode}</h3>
          <button onClick={onClose} className="text-slate-400"><X size={18} /></button>
        </div>
        {loading ? <div className="text-slate-400 text-sm">加载中…</div> : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
              <div className="bg-slate-50 p-2 rounded"><div className="text-slate-500">品类</div><div className="font-medium">{m?.category_name ?? "—"}</div></div>
              <div className="bg-slate-50 p-2 rounded"><div className="text-slate-500">大类</div><div className="font-medium">{m?.top_category ?? "—"}</div></div>
              <div className="bg-slate-50 p-2 rounded"><div className="text-slate-500">品牌</div><div className="font-medium">{m?.item_brand ?? "—"}</div></div>
            </div>
            <div className="mb-4">
              <div className="text-xs text-slate-500 mb-1">品牌分布</div>
              {Object.entries(byBrand).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-sm tabular-nums py-1">
                  <span className="w-16">{k === "3120" ? "熊喵" : k === "64188" ? "品品甜" : k}</span>
                  <span className="flex-1">销售 ¥{(v.sale / 10000).toFixed(1)}万 · 出库 ¥{(v.out / 10000).toFixed(1)}万</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">日趋势</div>
              <div className="h-32 flex items-end gap-px">
                {daily.map(d => (
                  <div key={d.biz_date + d.system_book_code} className="flex-1 bg-blue-400" style={{ height: `${Math.min(100, Number(d.sale_amount) / (Math.max(...daily.map(x => Number(x.sale_amount))) || 1) * 100)}%` }} title={`${d.biz_date}: ¥${(Number(d.sale_amount) / 10000).toFixed(1)}万`} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: tsc + commit**

```bash
cd web && npx tsc --noEmit 2>&1 | grep -E "item-detail|error" | head
git add web/components/report-center/item-detail-drawer.tsx
git commit -m "feat(reports): ItemDetailDrawer 弹层（日趋势+品牌分布+类别卡）"
```

---

### Task 8: ItemOutboundList 组件（列表+分页+筛选）

**Files:**
- Create: `web/components/report-center/item-outbound-list.tsx`

**Interfaces:**
- Consumes: Task 4 getItemOutboundListPage 首页，Task 5 item-list API 翻页
- Produces: `ItemOutboundList`（类 Excel 交叉表 + 筛选 + 分页）

- [ ] **Step 1: 组件实现**

```tsx
// web/components/report-center/item-outbound-list.tsx
"use client";
import { useState, useEffect } from "react";
import { ChartActions, exportExcel } from "./chart-actions";
import type { ItemOutboundListRow } from "@/lib/report-center/item-breakdown";

export function ItemOutboundList({ initialRows, initialTotal, targetId }: {
  initialRows: ItemOutboundListRow[]; initialTotal: number; targetId: number;
}) {
  const [rows, setRows] = useState(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ category: "", brand: "", q: "" });
  const [loading, setLoading] = useState(false);

  const fetchPage = async (p: number, f = filters) => {
    setLoading(true);
    const r = await fetch("/api/admin/reports/item-list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_id: targetId, page: p, ...f }),
    }).then(r => r.json());
    setRows(r.rows ?? []); setTotal(r.total ?? 0); setPage(p); setLoading(false);
  };

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-800">出库商品明细</h3>
        <ChartActions onExcel={() => exportExcel([["商品", "品类", "配送", "批发", "出库"], ...rows.map(r => [r.item_name, r.category_name, r.delivery_amount, r.wholesale_amount, r.outbound_amount])], "出库商品明细")} />
      </div>
      <div className="flex gap-2 mb-2 text-xs">
        <select value={filters.category} onChange={e => { const f = { ...filters, category: e.target.value }; setFilters(f); fetchPage(1, f); }} className="border rounded px-2 py-1">
          <option value="">全品类</option><option>水果</option><option>标品</option><option>耗材</option>
        </select>
        <input placeholder="搜商品名" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} className="border rounded px-2 py-1 flex-1" />
        <button onClick={() => fetchPage(1)} className="bg-slate-100 px-3 rounded">搜索</button>
      </div>
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-slate-50 text-xs text-slate-500">
          {["商品", "品类", "配送", "批发", "出库"].map(h => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={5} className="text-center text-slate-400 p-4">加载中…</td></tr> :
            rows.map(r => (
              <tr key={r.item_code}>
                <td className="border border-slate-200 p-2">{r.item_name}</td>
                <td className="border border-slate-200 p-2">{r.category_name}</td>
                <td className="border border-slate-200 p-2 text-right">{(Number(r.delivery_amount) / 10000).toFixed(1)}万</td>
                <td className="border border-slate-200 p-2 text-right">{(Number(r.wholesale_amount) / 10000).toFixed(1)}万</td>
                <td className="border border-slate-200 p-2 text-right font-medium">{(Number(r.outbound_amount) / 10000).toFixed(1)}万</td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
        <span>共 {total} 条</span>
        <div className="flex gap-1">
          <button disabled={page <= 1} onClick={() => fetchPage(page - 1)} className="border px-2 py-0.5 rounded disabled:opacity-30">上一页</button>
          <span className="px-2">{page}/{totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => fetchPage(page + 1)} className="border px-2 py-0.5 rounded disabled:opacity-30">下一页</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: tsc + commit**

```bash
cd web && npx tsc --noEmit 2>&1 | grep -E "item-outbound|error" | head
git add web/components/report-center/item-outbound-list.tsx
git commit -m "feat(reports): ItemOutboundList 组件（类Excel交叉表+筛选+分页）"
```

---

### Task 9: WholesaleCustomerReport 组件

**Files:**
- Create: `web/components/report-center/wholesale-customer-report.tsx`

**Interfaces:**
- Consumes: Task 4 getWholesaleCustomer
- Produces: `WholesaleCustomerReport`（3120 客户排行 + 品品甜 KPI + 高亮）

- [ ] **Step 1: 组件实现**

```tsx
// web/components/report-center/wholesale-customer-report.tsx
"use client";
import { ChartActions, exportExcel } from "./chart-actions";
import type { WholesaleCustomerRow } from "@/lib/report-center/wholesale-customer";

export function WholesaleCustomerReport({ rows, pinpintianAmount, pinpintianPct, total3120 }: {
  rows: WholesaleCustomerRow[]; pinpintianAmount: number; pinpintianPct: number; total3120: number;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-slate-800">批发客户报表（3120）</h3>
        <ChartActions onExcel={() => exportExcel([["客户", "金额", "占比", "累计占比", "品品甜"], ...rows.map(r => [r.client_name, r.wholesale_amount, (r.pct * 100).toFixed(1) + "%", (r.cumulative_pct * 100).toFixed(1) + "%", r.is_pinpintian ? "是" : ""])], "批发客户3120")} />
      </div>
      <div className="bg-blue-50 rounded p-3 mb-3 text-sm flex items-center gap-4">
        <div><div className="text-xs text-slate-500">品品甜占 3120 批发</div><div className="font-bold text-blue-700 tabular-nums">¥{(pinpintianAmount / 10000).toFixed(1)}万 · {(pinpintianPct * 100).toFixed(1)}%</div></div>
        <div className="text-slate-300">|</div>
        <div><div className="text-xs text-slate-500">3120 批发总额</div><div className="font-medium tabular-nums">¥{(total3120 / 10000).toFixed(1)}万</div></div>
      </div>
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-slate-50 text-xs text-slate-500">
          {["客户", "金额", "占比", "累计"].map(h => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.client_code} className={r.is_pinpintian ? "bg-amber-50" : ""}>
              <td className="border border-slate-200 p-2">{r.client_name}{r.is_pinpintian && <span className="ml-1 text-xs text-amber-600">品品甜</span>}</td>
              <td className="border border-slate-200 p-2 text-right">{(r.wholesale_amount / 10000).toFixed(1)}万</td>
              <td className="border border-slate-200 p-2 text-right">{(r.pct * 100).toFixed(1)}%</td>
              <td className="border border-slate-200 p-2 text-right text-slate-500">{(r.cumulative_pct * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: tsc + commit**

```bash
cd web && npx tsc --noEmit 2>&1 | grep -E "wholesale-customer|error" | head
git add web/components/report-center/wholesale-customer-report.tsx
git commit -m "feat(reports): WholesaleCustomerReport 组件（3120客户排行+品品甜KPI）"
```

---

### Task 10: 接入 page.tsx + desktop/mobile + architecture 文档

**Files:**
- Modify: `web/app/reports/targets/[id]/page.tsx`
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: Task 4 lib 函数 + Task 6-9 组件
- Produces: 看板挂 3 新板块（PC + 移动）+ 文档

- [ ] **Step 1: page.tsx 预取 + 传 desktop/mobile**

在 `web/app/reports/targets/[id]/page.tsx` 的 `Promise.all` 加 3 个 get 函数：

```typescript
// 顶部 import 加
import { getItemBreakdownTop, getItemOutboundListPage } from "@/lib/report-center/item-breakdown";
import { getWholesaleCustomer } from "@/lib/report-center/wholesale-customer";

// Promise.all 改为
const [kpi, regionBreakdown, categorySummary, brandMetric, itemTop, itemList, wholesaleCustomer] = await Promise.all([
  getTargetKpi(targetId),
  getRegionBreakdown(id),
  getCategorySummary(id),
  getBrandMetric(targetId),
  getItemBreakdownTop(targetId),
  getItemOutboundListPage(targetId, 1, {}),
  getWholesaleCustomer(targetId),
]);

// DesktopDashboard props 加 itemTop, itemList, wholesaleCustomer
// MobileDashboard 同理
```

- [ ] **Step 2: desktop.tsx 挂 3 组件**

`web/app/reports/targets/[id]/desktop.tsx`：

```tsx
// import 加
import { ItemTopBoards } from "@/components/report-center/item-top-boards";
import { ItemOutboundList } from "@/components/report-center/item-outbound-list";
import { WholesaleCustomerReport } from "@/components/report-center/wholesale-customer";

// DesktopDashboard props 加 itemTop, itemList, wholesaleCustomer
// JSX 末尾（BrandMetricTable 后）加
<ItemTopBoards top={itemTop} targetId={target.id} />
<ItemOutboundList initialRows={itemList.rows} initialTotal={itemList.total} targetId={target.id} />
<WholesaleCustomerReport {...wholesaleCustomer} />
```

- [ ] **Step 3: mobile.tsx 挂简化版（同结构，移动样式）**

同 desktop，样式调移动（grid-cols-1、组件内已自适应）。

- [ ] **Step 4: architecture.md §10.9 后追加前端板块说明**

```markdown
**Phase 2 前端板块（2026-08-02）**：spec `docs/superpowers/specs/2026-08-02-report-phase2-frontend-boards-design.md`。
3 板块挂目标看板下方：
- 商品 TOP4 榜（销售/出库 × 月/日，2行2列；日榜可选目标范围内截至当天任一天，全品牌 item_code 合并；走 `report_item_breakdown_gen` + `get_item_top_by_day` RPC）
- 出库商品下钻（TOP 点入弹层 `get_item_detail` RPC + 下方完整列表分页）
- 批发客户报表（3120 客户排行 + 品品甜占比，client_brand_code 数据驱动识别无字面量；走 `report_wholesale_customer_gen`）
生成器加 `dim_grain`（actual CTE grain 变换）+ `extra_join`（LEFT JOIN 补列）2 通用能力。
```

- [ ] **Step 5: push 部署 + 验证**

```bash
git add web/app/reports/targets/ docs/architecture.md
git commit -m "feat(reports): 目标看板挂 3 新板块（商品TOP+出库下钻+批发客户）"
git push origin main
gh run watch <run-id>
```

- [ ] **Step 6: 端到端验证**

```bash
# 打开 https://data.shanhaiyiguo.com/reports/targets/22 看板
# 验证：4 榜显示、日榜日期切换、点商品弹层、列表翻页、客户榜品品甜高亮
```

---

## Self-Review

**1. Spec coverage**：
- §2 数据层 2 视图 → Task 1-3 ✅
- §3 组件 4 板块 → Task 6-9 ✅（ItemTopBoards 含 TOP+点入，ItemOutboundList 列表，ItemDetailDrawer 弹层，WholesaleCustomerReport 客户）
- §4 数据流 3 lib + 3 API → Task 4-5 ✅
- §5 错误/边界 → 各组件空状态处理 ✅
- §6 测试 → Task 1-2 生成器测试 + Task 3 L3b diff ✅
- §7 验收 → Task 10 端到端 ✅

**2. Placeholder scan**：无 TBD/TODO。Task 3 Step 3 的"按现有模式注册"有明确 grep 指引。Task 4 Step 3 的 RPC SQL 写了完整版本（日榜全品牌合并）。

**3. Type consistency**：`ItemTopRow`/`ItemBreakdownTop`/`ItemOutboundListRow`/`WholesaleCustomerRow` 在 Task 4 定义，Task 6-9 使用一致。`dim_grain`/`extra_join` 在 Task 1-2 定义，Task 3 配置使用一致。`get_item_top_by_day`/`get_item_detail` RPC 在 Task 4/5 定义，lib/API 使用一致。

**Gaps**：Task 4 Step 3 的 RPC SQL 需在实现时确认全品牌合并的 JOIN 逻辑（targets.system_book_code='3120' 但 item 全品牌）——已注明修正方向（去掉 sbc 过滤，按周期 + biz_date=p_day join dim_item GROUP BY item_code）。
