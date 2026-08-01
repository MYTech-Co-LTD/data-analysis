# 目标管理版块重构设计

> **目标**：从 top-down（总目标→分解）改为 bottom-up（门店级→汇总→类目分解），修复三大漏洞，符合语义层生成器约束体系。

## 背景

### 当前问题

1. **target_type 硬编码错误**：新建目标时硬编码 `'store'`，导致总目标类型错误
2. **类别分解函数无法调用**：`upsert_hq_category_breakdown` 存在但 PostgREST 返回 404
3. **类别表使用总目标**：完成率计算不合理（用总目标除以各类别实际值）

### 业务洞察

**批发的组成**：批发 = 门店配送 + 外部客户

- 门店配送：有门店维度（总部→门店）
- 外部客户：无门店维度（总部→品品甜等外部客户）

**类目分解目标约束**：
- 类目总目标可以手动填写
- 但不得小于门店配送汇总（因为批发 ≥ 门店配送）

---

## 设计方案

### 1. 新流程设计

#### 当前流程（top-down）
```
新建目标（填写总目标值）→ 分解（手动填写门店/类目级目标）→ 校验（子目标和=总目标）
```

#### 新流程（bottom-up）
```
新建目标（仅名称+时间）→ 门店分解（填写门店级目标）→ 自动汇总（门店→区域→总目标）→ 类目分解（基于总目标）
```

#### 详细步骤

**阶段 1：新建目标**
- 输入：目标名称 + 时间范围
- 不涉及：汇总范围、目标值
- 输出：空目标记录（targets 表，无 target_metric_values）

**阶段 2：门店分解**
- 填写：每个门店的销售目标 + 配送目标
- 自动汇总：门店 → 二级区域（region_l2）→ 一级区域（war_zone）→ 总目标
- 存储：创建 breakdown 子目标（target_type='store'），写入 target_metric_values

**阶段 3：类目分解**
- 步骤 1：填写总出库目标（金额/毛利）
- 步骤 2：校验 —— 如果总目标 < 门店配送汇总 → 前端提醒 + 后端拦截
- 步骤 3：将总目标手动分配到三个类目（水果/标品/耗材）
- 存储：创建 hq 子目标（target_type='hq', category='水果'/'标品'/'耗材'），写入 target_metric_values

---

### 2. 数据库层面改造

#### targets 表结构（保持不变）
- `target_type`：'store'（门店目标）/'hq'（总部品类目标）
- `category`：'水果'/'标品'/'耗材'（仅 target_type='hq' 时有效）
- `breakdown_level`：'store'/'war_zone'/'region_l2'（仅 target_type='store' 时有效）

#### 目标值存储变化

**当前存储**：
```
总目标（id=22）：
  - outbound_amt: 1400万
  - outbound_profit: 140万
  - sale: 2300万
  - delivery: 1144万

门店子目标：
  - sale/delivery 按门店拆分
```

**新存储**：
```
总目标（id=22）：
  - sale: 2300万（来自门店汇总）
  - delivery: 1144万（来自门店汇总）
  - 无 outbound_amt/profit（不存储）

类别子目标：
  - id=xxx, parent_target_id=22, target_type='hq', category='水果'
    - outbound_amt: 800万
    - outbound_profit: 80万
  - id=xxx, parent_target_id=22, target_type='hq', category='标品'
    - outbound_amt: 400万
    - outbound_profit: 40万
  - id=xxx, parent_target_id=22, target_type='hq', category='耗材'
    - outbound_amt: 200万
    - outbound_profit: 20万

门店子目标：
  - sale/delivery 按门店拆分（不变）
```

#### 修复 `upsert_hq_category_breakdown` 函数

**问题**：PostgREST 返回 404，无法调用

**修复步骤**：
1. 检查权限：
   ```sql
   GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
   ```
2. 如仍失败，检查 PostgREST schema 缓存：
   ```bash
   docker restart deploy-postgrest-1
   ```
3. 如仍失败，创建包装函数：
   ```sql
   CREATE OR REPLACE FUNCTION upsert_hq_category_breakdown_wrapper(p_parent_id BIGINT, p_rows JSONB, p_by TEXT)
   RETURNS JSONB LANGUAGE plpgsql AS $$
   BEGIN
     RETURN upsert_hq_category_breakdown(p_parent_id, p_rows, p_by);
   END $$;
   ```

#### 新增校验逻辑

**类别分解校验**（在 `upsert_hq_category_breakdown` 函数内部）：
```sql
-- 计算门店配送汇总（该 parent_target_id 下所有门店子目标的 delivery 总和）
SELECT COALESCE(SUM(tmv.target_value), 0) INTO v_delivery_sum
FROM targets t
JOIN target_metric_values tmv ON tmv.target_id = t.id
WHERE t.parent_target_id = p_parent_id
  AND t.target_type = 'store'
  AND tmv.metric_code = 'delivery';

-- 计算类目总目标
SELECT COALESCE(SUM((v_row->'metrics'->>'outbound_amt')::numeric), 0) INTO v_total_outbound
FROM jsonb_array_elements(p_rows) AS v_row;

-- 校验：总目标 ≥ 门店配送汇总
IF v_total_outbound < v_delivery_sum THEN
  RAISE EXCEPTION '总出库目标 % 小于门店配送汇总 %', v_total_outbound, v_delivery_sum;
END IF;
```

---

### 3. 前端层面改造

#### 新建目标页面（web/app/admin/targets/page.tsx）

**删除**：
- 汇总范围选择器（system_book_code）
- 总部板块（类别目标表格）

**保留**：
- 目标名称输入框
- 时间范围选择器（开始日期/结束日期）

**修改 API 调用**：
```typescript
// 当前（line 98）：
target_type: 'store', metrics: totalMetrics

// 改为：
// 仅传名称 + 时间，不传 target_type 和 metrics
{ name, start_date, end_date }
```

#### 分解页面（web/app/admin/targets/[id]/page.tsx）

**门店板块**：保持不变

**总部板块**：
- **删除**：汇总范围相关逻辑（sbc 参数）
- **新增校验**（line 110-128）：
  ```typescript
  const deliverySum = branchRows.reduce((s, r) => s + (Number(r.metrics?.delivery) || 0), 0);
  const outboundTotal = hqSum('outbound_amt');
  if (outboundTotal < deliverySum) {
    if (!confirm(`总出库目标 ${outboundTotal} 小于门店配送汇总 ${deliverySum}，确认保存？`)) {
      return;
    }
  }
  ```

#### 类别表前端（web/lib/report-center/category-summary.ts）

**修改查询**：
```typescript
// 当前：
.from("report_category_summary_v")

// 改为：
.from("report_category_summary_gen")
```

---

### 4. 后端/API 层面改造

#### 调整 `upsert_target_total` 函数

**当前逻辑**：创建总目标 + 写入所有目标值（包括 outbound_amt/profit）

**改造方案**（两个选择）：

**方案 A：简化函数（推荐）**
- 仅创建总目标，不写入目标值
- 目标值在分解阶段写入
- 优点：逻辑清晰，职责单一
- 缺点：需要调整前端 API 调用

**方案 B：保持现有逻辑**
- 创建总目标 + 写入销售/配送目标值
- 类别目标值在分解阶段覆盖
- 优点：改动最小
- 缺点：存在中间状态（总目标有 outbound 值但会被覆盖）

**推荐方案 A**，修改函数签名：
```sql
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, 
  p_name TEXT, 
  p_start DATE, 
  p_end DATE, 
  p_by TEXT
) RETURNS JSONB
```

#### API 路由调整

**新建目标 API（web/app/api/admin/targets/route.ts）**：
- POST：调用 `upsert_target_total`（仅传 name + start + end）
- 不再传递 `target_type` 和 `metrics`

**分解 API（web/app/api/admin/targets/breakdown/route.ts）**：
- 保持现有逻辑
- 门店分解：调用 `upsert_target_breakdown`
- 类别分解：调用 `upsert_hq_category_breakdown`

---

### 5. 类别表改造（语义层版）

#### 核心原则

类别表 = 生成器产出（`report_category_summary_gen.sql`）
- 指标定义在 `metric_registry`
- 数据来源在 `metric_sources`
- 无手写 SQL、无硬编码口径
- 严格符合反自由发挥约束

#### 补充 metric_registry

**类别级出库指标**：
```sql
-- outbound_amount = delivery_amount + wholesale_amount
INSERT INTO metric_registry (metric_code, name, measure_type, formula_ast, additive, unit, enabled) VALUES
('outbound_amount', '出库金额', 'derived', 
 '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_amount"}}',
 false, '元', true),
 
('outbound_profit', '出库毛利', 'derived',
 '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_profit"}}',
 false, '元', true);
```

**注意**：
- `delivery_amount` 和 `wholesale_amount` 需要在 metric_registry 中定义（base 指标）
- 或者直接用表名列：`delivery.out_money`、`wholesale.wholesale_money`

#### 补充 metric_sources

**数据来源映射**：
```sql
-- 配送来源
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter) VALUES
('delivery_amount', 'report_daily_delivery', 'out_money', NULL),
('delivery_profit', 'report_daily_delivery', 'profit_money', NULL);

-- 批发来源
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter) VALUES
('wholesale_amount', 'report_daily_wholesale', 'wholesale_money', NULL),
('wholesale_profit', 'report_daily_wholesale', 'wholesale_profit', NULL);
```

#### 改造生成器

**支持 category 维度**：

1. **types.ts**：
   - `ViewConfig.dim_code` 增加 `'category'` 类型
   - `target_breakdown` 增加 `'category'` 选项

2. **tier1.ts**：
   - 识别 `dim_code='category'` 时，GROUP BY `category_group` 列
   - JOIN `report_daily_delivery` 和 `report_daily_wholesale`（UNION ALL）
   - 目标值从类别分解子目标读取（WHERE parent_target_id=总目标 AND category=维度值）

3. **view-configs.ts**：
   ```typescript
   {
     view_name: 'report_category_summary_gen',
     dim_code: 'category',
     metrics: ['outbound_amount', 'outbound_profit'],
     scope: { target_window: true },
     total_row: true,
     target_breakdown: 'category',
   }
   ```

#### 目标值读取逻辑

**从类别分解子目标读取**：
```sql
-- 在生成器中构建 JOIN
LEFT JOIN targets cat_target 
  ON cat_target.parent_target_id = tgt.target_id 
  AND cat_target.category = delivery.category_group  -- 维度匹配
  AND cat_target.target_type = 'hq'
LEFT JOIN target_metric_values tmv 
  ON tmv.target_id = cat_target.id 
  AND tmv.metric_code = 'outbound_amt'
```

**严格约束**：
- 如果没有类别分解子目标 → 目标值为 NULL（不 fallback）
- 强制用户完成类别分解，才能看到类别报表

---

### 6. 迁移计划

#### 迁移文件

**迁移 132：修复 `upsert_hq_category_breakdown` 权限**
```sql
-- 132_fix_hq_category_breakdown_permission.sql
GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO anon, authenticated;
```

**迁移 133：补充 metric_registry/metric_sources**
```sql
-- 133_add_category_metrics.sql
-- 补充 outbound_amount/outbound_profit 指标
-- 补充 delivery/wholesale 数据来源
```

**迁移 134：简化 `upsert_target_total` 函数**
```sql
-- 134_simplify_upsert_target_total.sql
-- 删除 metrics 参数，仅创建空目标
```

#### 前端改造

**优先级 1：修复类别分解函数**
- 确认 PostgREST 可调用 `upsert_hq_category_breakdown`
- 验证类别分解功能可用

**优先级 2：简化新建目标流程**
- 修改 `page.tsx`：删除汇总范围、类别表格
- 修改 API 调用：仅传名称+时间

**优先级 3：生成器改造**
- 支持 `dim_code='category'`
- 产出 `report_category_summary_gen.sql`

**优先级 4：前端切换**
- `category-summary.ts` 改为查询 `_gen`
- DROP `report_category_summary_v`

---

### 7. 测试验证

#### 功能测试

1. **新建目标流程**：
   - 创建目标 → 确认无目标值 → 仅存储名称+时间
   - 查询 targets 表 → 确认 target_level='total', 无 target_metric_values

2. **门店分解**：
   - 填写门店目标 → 汇总正确（门店→区域→总目标）
   - 查询 targets 表 → 确认 breakdown 子目标存在，target_metric_values 正确

3. **类别分解**：
   - 填写总目标 < 门店配送汇总 → 校验提醒
   - 填写总目标 ≥ 门店配送汇总 → 成功保存
   - 查询 targets 表 → 确认 hq 子目标存在，target_type='hq', category 正确

4. **类别表**：
   - 查询 `_gen` 视图 → 确认目标值来自类别分解子目标
   - 未完成类别分解 → 目标值为 NULL

#### 回归测试

- 现有目标（如 target_id=22）：
  - 保持门店分解功能正常
  - 新增类别分解功能可用
- 类别表前端：
  - 切换到 `_gen` 后数据正确
  - 完成率计算合理（实际值/类别目标）

---

## 成功标准

1. ✅ 新建目标：仅传名称+时间，不存储目标值
2. ✅ 类别分解函数：PostgREST 可调用，无 404 错误
3. ✅ 类别表：从类别分解子目标读取目标值，符合生成器约束
4. ✅ 校验逻辑：总目标 < 门店配送汇总时前端提醒+后端拦截
5. ✅ 前端改动最小：仅改校验规则，页面结构基本不变

---

## 风险

| 风险 | 缓解 |
|------|------|
| `upsert_hq_category_breakdown` 仍无法调用 | 创建包装函数，或改用 SECURITY INVOKER |
| 前端改动影响现有目标 | 分解页面保持向后兼容，新旧目标都能正常编辑 |
| 生成器改造复杂度高 | 先修复函数漏洞，生成器化后续迭代 |
| 类别表迁移后数据缺失 | 提示用户完成类别分解，或在迁移脚本中初始化类别分解数据 |