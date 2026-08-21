# 出库明细合并视图（outbound_detail）——配送∪批发统一查询

> 迁移：`database/migrations/205_outbound_detail_registry.sql`
> 关联代码：`functions/agent-query/index.js`（runDuckdb 合并视图 + 白名单）
> 日期：2026-08-20

## 背景

公司旗下两品牌：熊喵鲜生(3120)、品品甜(64188)，区域跨品牌（如东部战区两品牌门店都有）。
业务数据模型（账套视角）：
- **配送**：熊喵自营配送在 `transfer_detail`（3120，response_branch_num=熊喵门店）；
- **批发**：品品甜经熊喵供应链拿货，数据在 `wholesale_detail`（3120 账套，client_name=品品甜门店），
  经 client_name→dim_branch(64188).branch_name 精确匹配映射到品品甜门店（066 同款逻辑）；
- 外部批发客户（供应链公司）→ 映射失败归 '99'，不进门店维度。

因此"出库明细"（配送∪批发）跨两张表，且品牌/区域跨表——需合并视图统一查询。

## 方案

- **引擎**：DuckDB（明细层，5 分钟采集实时可见；PG 语义聚合层不动）。
- **形态**：查询时实时合并视图（方案 A，零采集改动）——collector 照常写各表，视图每次查询重建吃到最新数据。
- **权限**：合并视图内嵌权限沙箱（Split-Plane 同款）：
  - 行级：`regexp_replace(sbc||'-'||branch_num, 归一) IN (用户branch_nums)`——每行归位 (sbc, branch_num)：
    delivery→(3120, response_branch_num)；wholesale→(64188, client映射店号)；外部客户→99 自然滤出；
  - 列级：profit 按 can_see_cost 脱敏（NULL）。
  - 已验证（ZhangDuo）：外部客户 0 行、去重门店 67≤69、品品甜批发 1602 行可见、熊喵配送 21038 行可见、profit 全 NULL。

## 权限验证（Step 1 结果）

| 断言 | 结果 |
|---|---|
| 外部客户(99) 不出现 | ✅ 0 行 |
| 去重门店 ≤ 用户可见数 | ✅ 67 ≤ 69 |
| 品品甜(64188)批发可见 | ✅ 1602 行 |
| 熊喵(3120)配送可见 | ✅ 21038 行 |
| 毛利脱敏(无权限=NULL) | ✅ |

## 实现

1. `functions/agent-query/index.js` runDuckdb：构建 outbound_detail 临时视图（delivery ∪ wholesale + client 映射 + 权限沙箱 + profit 脱敏），加入 allowedTables 白名单。
2. `205_outbound_detail_registry.sql`：注册字典元数据（list_datasets 可见）。

## 回滚

- 字典：`DELETE FROM datasets WHERE name='outbound_detail'`（级联删列描述）；
- 网关：从 allowedTables 移除 outbound_detail、runDuckdb 移除视图构建。
- 数据本身无改动（视图是查询时实时合并，无物化存储）。
