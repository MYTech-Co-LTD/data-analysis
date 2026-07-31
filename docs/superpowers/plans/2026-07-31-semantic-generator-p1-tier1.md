# P1: Tier1 生成器 + 配销比 + 品牌表实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Tier1 生成器逻辑，迁移配销比和品牌表两张视图到生成器产物

**Architecture:** Tier1 生成器读取 metric_registry + metric_sources，产出 report_*_gen.sql 视图。三层校验：L1 静态校验（已有）、L2 EXPLAIN 生成时校验、L3b 双轨对账。

**Tech Stack:** TypeScript + Node.js (services/semantic-generator)

## Global Constraints

- 视图 `DROP VIEW IF EXISTS + CREATE VIEW`，禁 `CREATE OR REPLACE`
- migrate.sh 每次部署重跑全部迁移——所有 DDL 幂等
- 加视图后 `docker compose restart postgrest` 刷 schema 缓存
- 比率指标不能直接 SUM，须 `SUM(profit)/SUM(amount)` 重算——靠 `additive=false` 标记 + 生成器保证
- 门店键 = `(system_book_code, branch_num)` 复合

---

## 任务概览

| 序号 | 任务 | 描述 |
|------|------|------|
| T1 | 理解现有前端 ratio.ts | 读前端配销比计算逻辑，理解口径 |
| T2 | Tier1 生成器核心逻辑 | 实现 generateTier1View() 生成 base+additive+rate+cost_mask+target join |
| T3 | 生成 report_brand_metric_gen | 按 spec 4.2 序号② 产出品牌表视图 |
| T4 | L3b 双轨 diff 验证 | 对比 report_brand_metric_gen vs report_brand_metric_v |
| T5 | 前端切换到生成视图 | 把前端 .from() 切到 _gen |
| T6 | 下线旧视图 | 确认双轨 diff=0 后删旧视图 |
| T7 | 端到端验证 | 整体跑通 + 收口提交 |

---

### Task 1: 理解现有前端 ratio.ts 配销比逻辑

**Files:**
- Read: `web/app/report/brand/[brandId]/ratio.ts` (前端配销比计算)
- Read: `database/views/report_brand_metric_v.sql` (现有品牌表视图)
- Read: `database/migrations/123_*.sql` (已注册的 metric_registry 数据)

**Interfaces:**
- Consumes: 前端 ratio.ts 业务逻辑、metric_registry 指标定义
- Produces: 配销比口径文档（哪些 metric_code 用于计算 ratio）

**Steps:**

- [ ] **Step 1: 读取前端 ratio.ts**

```bash
cat web/app/report/brand/\[brandId\]/ratio.ts
```

理解：配销比 = delivery / sale 的计算逻辑，从哪个视图取数、哪些字段。

- [ ] **Step 2: 读取现有品牌表视图**

```bash
cat database/views/report_brand_metric_v.sql
```

理解：现有视图结构，聚合维度（brand × metric），包含哪些指标。

- [ ] **Step 3: 读取 metric_registry 已注册指标**

```bash
# 查数据库或 migration 文件
grep -A 20 "metric_registry" database/migrations/123_*.sql
```

确认：sale/delivery/outbound_amt 已在 registry 中定义。

- [ ] **Step 4: 整理配销比口径文档**

记录：
- ratio = delivery_sale_ratio 定义（哪个 metric_code）
- 计算公式
- 需要的 source 数据

---

### Task 2: Tier1 生成器核心逻辑

**Files:**
- Modify: `services/semantic-generator/src/index.ts` (添加 generateTier1View 函数)
- Modify: `services/semantic-generator/src/types.ts` (扩展 ViewConfig 支持 tier1 配置)
- Create: `services/semantic-generator/src/generators/tier1.ts` (Tier1 生成器核心)
- Test: `services/semantic-generator/__tests__/tier1.test.ts` (TDD)

**Interfaces:**
- Consumes: `Metric[]` from registry-reader, `MetricSource[]` from sources, `ViewConfig`
- Produces: `generateTier1View(config): string` 返回 CREATE VIEW SQL

**Steps:**

- [ ] **Step 1: 写失败的测试**

```typescript
// services/semantic-generator/__tests__/tier1.test.ts
import { generateTier1View } from '../src/generators/tier1';

describe('Tier1 Generator', () => {
  it('should generate base aggregation for additive metrics', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['sale', 'delivery'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: ['sale', 'delivery']
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('SUM(sale_amount)');
    expect(sql).toContain('SUM(delivery_amount)');
  });

  it('should recalculate rate metrics (additive=false)', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['delivery_sale_ratio'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: []
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // 率不能用 SUM，要用 SUM(profit)/SUM(amount)
    expect(sql).toContain('SUM(delivery_amount) / NULLIF(SUM(sale_amount), 0)');
  });

  it('should apply cost masking for cost_sensitive=true', () => {
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // 有 can_see_cost claim 时正常，否则毛利列 NULL
    expect(sql).toContain('CASE WHEN current_setting(\'request.jwt.claim.can_see_cost\', true)');
  });

  it('should join target_metric_values by breakdown_level', () => {
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // 按 breakdown_level (brand) join target
    expect(sql).toContain('LEFT JOIN target_metric_values');
    expect(sql).toContain('ON t.system_book_code = s.system_book_code');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
cd services/semantic-generator && npm test -- --testPathPattern=tier1
# 预期: FAIL - generateTier1View not defined
```

- [ ] **Step 3: 实现 Tier1 生成器**

```typescript
// services/semantic-generator/src/generators/tier1.ts
import { Metric, MetricSource, ViewConfig } from '../types';

export function generateTier1View(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const { view_name, metrics: metricCodes, dim_code, levels, target_metric_codes } = config;
  
  // 1. 按 additive 分类指标
  const additiveMetrics = metricCodes.filter(m => m.additive);
  const nonAdditiveMetrics = metricCodes.filter(m => !m.additive);
  
  // 2. 生成 SELECT 子句
  const selectParts: string[] = [];
  
  // 维度列
  if (dim_code === 'brand') {
    selectParts.push('s.system_book_code AS brand_code');
  }
  
  // 3. base 聚合 (additive=true 直接 SUM)
  for (const code of additiveMetrics) {
    const source = sources.find(s => s.metric_code === code);
    if (source) {
      const col = source.source_column || `${code}_amount`;
      selectParts.push(`SUM(${col}) AS ${code}_amount`);
    }
  }
  
  // 4. 率重算 (additive=false 用 SUM/NULLIF 重算)
  for (const code of nonAdditiveMetrics) {
    const metric = metrics.find(m => m.metric_code === code);
    if (metric?.formula) {
      // formula: "delivery_amount / sale_amount" -> 转为 SUM(delivery)/SUM(sale)
      const recalculated = metric.formula.replace(
        /(\w+)_amount/g, 
        'SUM($1_amount)'
      ).replace(/\//, ' / NULLIF(') + ', 0)';
      selectParts.push(`${recalculated} AS ${code}`);
    }
  }
  
  // 5. cost 脱敏 (cost_sensitive=true 套 CASE)
  for (const code of metricCodes) {
    const metric = metrics.find(m => m.metric_code === code);
    if (metric?.cost_sensitive) {
      const idx = selectParts.length - 1;
      const original = selectParts[idx];
      selectParts[idx] = `CASE WHEN current_setting('request.jwt.claim.can_see_cost', true) = 'true' 
        THEN ${original.replace('SUM(', 'SUM(')} 
        ELSE NULL END AS ${code}_amount`;
    }
  }
  
  // 6. target join
  let from = 'report_daily_delivery s';
  if (target_metric_codes.length > 0) {
    from += `\nLEFT JOIN target_metric_values t 
      ON t.system_book_code = s.system_book_code 
      AND t.metric_code IN (${target_metric_codes.map(c => `'${c}'`).join(',')})`;
  }
  
  // 7. GROUP BY
  const groupBy = dim_code === 'brand' ? 's.system_book_code' : '';
  
  return `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
SELECT ${selectParts.join(',\n  ')}
FROM ${from}
${groupBy ? `GROUP BY ${groupBy}` : ''}`;
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
cd services/semantic-generator && npm test -- --testPathPattern=tier1
# 预期: PASS
```

- [ ] **Step 5: 提交**

```bash
git add services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/tier1.test.ts
git commit -m "feat(generator): add Tier1 view generator with additive/rate/cost-mask logic"
```

---

### Task 3: 生成 report_brand_metric_gen 视图

**Files:**
- Modify: `services/semantic-generator/src/index.ts` (调用 generateTier1View)
- Create: `database/generated/report_brand_metric_gen.sql` (生成产物)

**Interfaces:**
- Consumes: Tier1 生成器、metric_registry 数据
- Produces: `database/generated/report_brand_metric_gen.sql`

**Steps:**

- [ ] **Step 1: 配置品牌表视图生成**

在 index.ts 中添加配置：

```typescript
// 品牌表视图配置 (spec 4.2 序号②)
const brandMetricView: ViewConfig = {
  view_name: 'report_brand_metric_gen',
  metrics: ['sale', 'delivery', 'outbound_amt', 'outbound_profit', 'delivery_sale_ratio'],
  dim_code: 'brand',
  levels: ['brand'],
  target_metric_codes: ['sale', 'delivery', 'outbound_amt']
};
```

- [ ] **Step 2: 运行生成器**

```bash
cd services/semantic-generator && npm run gen-views
# 预期: 生成 database/generated/report_brand_metric_gen.sql
```

- [ ] **Step 3: 检查生成产物**

```bash
cat database/generated/report_brand_metric_gen.sql
```

验证：
- 有 `SUM(sale_amount)` / `SUM(delivery_amount)` (additive)
- 有 `SUM(delivery_amount) / NULLIF(SUM(sale_amount), 0)` (率重算)
- 有 `CASE WHEN current_setting` (cost mask)
- 有 `LEFT JOIN target_metric_values`

- [ ] **Step 4: 本地 DB 部署验证**

```bash
# 部署到本地 dev DB
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "
docker exec deploy-postgres-1 psql -U postgres -d insforge -f /path/to/generated/report_brand_metric_gen.sql
"
```

- [ ] **Step 5: L2 EXPLAIN 校验**

```bash
cd services/semantic-generator && npm run explain -- report_brand_metric_gen
# 预期: EXPLAIN 成功，无语法/字段错误
```

- [ ] **Step 6: 提交**

```bash
git add database/generated/report_brand_metric_gen.sql
git commit -m "feat(generated): add report_brand_metric_gen view"
```

---

### Task 4: L3b 双轨 diff 验证

**Files:**
- Run: `services/semantic-generator/src/diff.ts` (已有工具)

**Interfaces:**
- Consumes: report_brand_metric_gen, report_brand_metric_v
- Produces: diff 报告

**Steps:**

- [ ] **Step 1: 运行双轨 diff**

```bash
cd services/semantic-generator && npm run diff -- --old report_brand_metric_v --new report_brand_metric_gen
```

预期输出示例：
```
Checking report_brand_metric_gen vs report_brand_metric_v...
sale_amount: diff = 0 ✅
delivery_amount: diff = 0 ✅
outbound_amt: diff = 0 ✅
outbound_profit: diff = 0 ✅
delivery_sale_ratio: diff = 0 ✅
All columns match!
```

- [ ] **Step 2: 如有 diff，排查**

如果 diff ≠ 0：
1. 检查 metric_registry 的 formula 是否与手写视图一致
2. 检查 source_filter 是否正确
3. 对比生成 SQL 与手写 SQL 差异

- [ ] **Step 3: 记录验证结果**

```bash
# 保存 diff 结果到文件
npm run diff -- --old report_brand_metric_v --new report_brand_metric_gen > /tmp/brand_diff.txt
```

---

### Task 5: 前端切换到生成视图

**Files:**
- Modify: `web/app/report/brand/[brandId]/page.tsx` (或其他引用 report_brand_metric_v 的文件)
- Modify: `web/lib/api.ts` 中的视图选择逻辑

**Interfaces:**
- Consumes: report_brand_metric_gen 已部署
- Produces: 前端切换到读 _gen 视图

**Steps:**

- [ ] **Step 1: 查找前端引用**

```bash
grep -r "report_brand_metric_v" web/
```

找到所有引用该视图的前端代码。

- [ ] **Step 2: 切换到 _gen**

把 `report_brand_metric_v` 改为 `report_brand_metric_gen`。

例如在 api.ts 中：
```typescript
// 旧
const VIEW = 'report_brand_metric_v';
// 新
const VIEW = 'report_brand_metric_gen';
```

- [ ] **Step 3: 验证前端正常**

```bash
# 本地 dev 测试
npm run dev
# 访问品牌报表页，确认数据正常显示
```

- [ ] **Step 4: 提交**

```bash
git add web/
git commit -m "feat(ui): switch brand metric to generated view"
```

---

### Task 6: 下线旧视图

**Files:**
- Create: `database/migrations/xxx_drop_old_brand_view.sql` (删除旧视图)
- Run: postgrest restart

**Interfaces:**
- Consumes: 双轨 diff=0 确认
- Produces: 旧视图删除

**Steps:**

- [ ] **Step 1: 创建删除迁移**

```sql
-- database/migrations/xxx_drop_old_brand_view.sql
DROP VIEW IF EXISTS report_brand_metric_v;
```

- [ ] **Step 2: 部署迁移**

```bash
# 先本地验证
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "
docker exec deploy-postgres-1 psql -U postgres -d insforge -f - <<'SQL'
DROP VIEW IF EXISTS report_brand_metric_v;
SQL
"
```

- [ ] **Step 3: 重启 postgrest**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "
docker compose -f /opt/data-analytics-platform/deploy/docker-compose.yml restart postgrest
"
```

- [ ] **Step 4: 确认前端仍正常**

访问品牌报表页，确认功能正常。

- [ ] **Step 5: 提交**

```bash
git add database/migrations/
git commit -m "feat(migration): drop old report_brand_metric_v view"
```

---

### Task 7: 端到端验证 + 收口提交

**Files:**
- Run: L1 静态校验
- Run: L3a rollup audit

**Interfaces:**
- Consumes: 全量生成视图
- Produces: 完整验证报告

**Steps:**

- [ ] **Step 1: L1 静态校验**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT validate_semantic_registry();\"
"
```

预期: 成功返回

- [ ] **Step 2: L3a rollup audit**

```bash
# 如果有 audit 视图
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT * FROM report_brand_metric_gen_audit LIMIT 10;\"
"
```

预期: 空结果（零行 = rollup 一致）

- [ ] **Step 3: 功能验证**

1. 访问品牌报表页，确认配销比数据正确
2. 访问 KPI 卡片，确认数据正常
3. 检查 cost 脱敏：未登录时毛利为 NULL

- [ ] **Step 4: 合并到 main**

```bash
git checkout main
git pull
git merge p1-tier1-generator
git push origin main
```

---

## 验收标准

| 标准 | 验证方式 |
|------|----------|
| Tier1 生成器正确 | 测试通过 + L2 EXPLAIN 成功 |
| 双轨 diff=0 | `npm run diff` 全列匹配 |
| 前端功能正常 | 页面访问 + 数据正确 |
| Cost 脱敏工作 | 未登录时毛利列 NULL |
| Target join 工作 | 有目标的品牌显示目标值 |
| Rollup 一致 | L3a audit 空 |
| L1 校验通过 | `validate_semantic_registry()` 返回成功 |

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 双轨 diff 不为 0 | 保持双轨运行，排查口径差异 |
| Cost 脱敏不生效 | 本地 RLS 测试验证 |
| PostgREST 缓存未刷新 | 显式 restart postgrest |
| 前端切换后数据异常 | 保留旧视图，回滚机制 |

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-31-semantic-generator-p1-tier1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
