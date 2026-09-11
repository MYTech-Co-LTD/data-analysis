-- 213_replenishment_detail_registry.sql
-- spec: docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md
-- 补货（要货单）明细接入问数：数据集注册 + 到达/完整性守护规则。
-- 数据来源：其他系统的 duckle 管线写入
--   s3://lemeng-datasource/duckle/lemeng/replenishment_detail/<账套>/<YYYY-MM-DD>/all.parquet
-- ★ total_money 有意不注册：它是单头金额、逐行重复（实测恒等于该单 sum(subtotal)），
--   行级 SUM 会整单翻倍。视图按注册列投影 → 不注册即不可见。单头金额请按 order_no 分组 SUM(subtotal)。
-- 行级权限：scope_key_expr = 账套||'-'||门店号 归一（门店号跨账套重复，必须复合）。
-- 源列名映射：parquet 里账套列真名是 company_id，平台口径名（含网关门店键守卫）必须是 system_book_code，
--   故用 dataset_columns.source_name 声明「源列名 → 视图列名」映射，不要求外部管线改名。
-- 幂等：全部用 ON CONFLICT ... DO UPDATE（见各段说明；DO NOTHING / WHERE NOT EXISTS 已证明会让回填与
--   后续修正静默 no-op）。
BEGIN;

-- ===== 1. 数据集行 =====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed,
                      date_column, date_format, carry_enabled, exposed, scope_key_expr, description)
VALUES (
  'replenishment_detail',
  '补货明细(要货单)',
  'duckdb_view',
  's3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet',
  'fact',
  TRUE, TRUE,
  'business_date', 'YYYY-MM-DD HH:MM:SS', FALSE, TRUE,
  'regexp_replace(system_book_code || ''-'' || branch_num, ''^([0-9]+)-0+([0-9]+)$'', ''\1-\2'')',
  '补货单(要货单)商品行；一行=一单一商品。口径：默认只算已审核生效单(state_name=''制单|审核'')，作废/未审核默认排除。金额用 SUM(subtotal)，单头金额按 order_no 分组 SUM(subtotal)。门店键必须 system_book_code+branch_num 复合（跨账套重号）'
)
-- 用 DO UPDATE 而非 DO NOTHING：否则本迁移日后修正（描述/来源/表达式）在已落库的库上会**静默 no-op**
-- ——「看起来部署了，什么也没改」。列名可枚举，全量覆写是幂等且可预期的。
ON CONFLICT (name) DO UPDATE SET
  display_name=EXCLUDED.display_name, engine=EXCLUDED.engine, source=EXCLUDED.source,
  kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime, columns_typed=EXCLUDED.columns_typed,
  date_column=EXCLUDED.date_column, date_format=EXCLUDED.date_format,
  carry_enabled=EXCLUDED.carry_enabled, exposed=EXCLUDED.exposed,
  scope_key_expr=EXCLUDED.scope_key_expr, description=EXCLUDED.description;

-- ===== 2. 列注册（视图暴露列 = 本清单；total_money intentionally absent）=====
-- data_type 取**真实 parquet 实测值**（2026-09-11 服务器 DuckDB 验证），不是沿用 lemeng 原生表的「全 VARCHAR」。
-- source_name 只给账套列用：parquet 里它叫 company_id，而平台口径名（含网关门店键守卫）必须叫 system_book_code。
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, source_name, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.source_name, v.description, v.ordinal
FROM (VALUES
  ('replenishment_detail','system_book_code','VARCHAR','维度',FALSE,'dim_branch(system_book_code,branch_num)','company_id','品牌账套：3120=熊喵鲜生 / 64188=品品甜。源列名 company_id → 视图列名 system_book_code。门店键必须与 branch_num 复合使用',1),
  ('replenishment_detail','branch_num','BIGINT','门店',FALSE,'dim_branch(system_book_code,branch_num)',NULL,'要货门店号（跨账套重号，禁止单独作 join 键）。BIGINT；与字符串拼接 DuckDB 会隐式转换',2),
  ('replenishment_detail','branch_name','VARCHAR','门店',FALSE,NULL,NULL,'要货门店名',3),
  ('replenishment_detail','out_branch_num','BIGINT','门店',FALSE,NULL,NULL,'出货方号（=99 管理中心/配送中心）',4),
  ('replenishment_detail','out_branch_name','VARCHAR','门店',FALSE,NULL,NULL,'出货方名',5),
  ('replenishment_detail','order_no','VARCHAR','单据',FALSE,NULL,NULL,'要货单号（带账套前缀 YH3120…/YH64188…，两账套不撞；与 item_num 合起来全局唯一）',6),
  ('replenishment_detail','order_type','VARCHAR','单据',FALSE,NULL,NULL,'单据类型（要货单）',7),
  ('replenishment_detail','state_name','VARCHAR','单据',FALSE,NULL,NULL,'单据状态：制单 / 制单|审核 / 制单|作废 / 制单|审核|作废。默认口径只看 ''制单|审核''',8),
  ('replenishment_detail','business_date','VARCHAR','日期',FALSE,NULL,NULL,'业务日（**全时间戳**）。按日过滤用 substr(business_date,1,10)；与分区目录名恒等（实测 0 例外）',9),
  ('replenishment_detail','create_time','VARCHAR','日期',FALSE,NULL,NULL,'制单时间',10),
  ('replenishment_detail','audit_time','VARCHAR','日期',FALSE,NULL,NULL,'审核时间（未审核单为空）',11),
  ('replenishment_detail','item_num','BIGINT','商品',FALSE,'dim_item(system_book_code,item_num)',NULL,'账套内商品编号（跨账套重号）。与 dim_item 关联必须配 system_book_code 复合成键',12),
  ('replenishment_detail','item_code','VARCHAR','商品',FALSE,'dim_item.item_code',NULL,'货来源编码（跨账套全局唯一），可单独作键',13),
  ('replenishment_detail','item_name','VARCHAR','商品',FALSE,NULL,NULL,'商品展示名。⚠禁止用 item_name 做 join 键（双账套同名不同货）',14),
  ('replenishment_detail','item_spec','VARCHAR','商品',FALSE,NULL,NULL,'规格',15),
  ('replenishment_detail','item_unit','VARCHAR','商品',FALSE,NULL,NULL,'基本单位',16),
  ('replenishment_detail','quantity','DOUBLE','数量',FALSE,NULL,NULL,'要货数量（基本单位口径）',17),
  ('replenishment_detail','use_quantity','DOUBLE','数量',FALSE,NULL,NULL,'要货数量（件数口径，配 use_unit）',18),
  ('replenishment_detail','use_unit','VARCHAR','数量',FALSE,NULL,NULL,'件单位',19),
  ('replenishment_detail','subtotal','DOUBLE','金额',FALSE,NULL,NULL,'行金额（行级求和的唯一正确列）。单头金额 = 按 order_no 分组 SUM(subtotal)',20)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, source_name, description, ordinal)
-- DO UPDATE 而非 WHERE NOT EXISTS：后者在已落库的库上会让本迁移的**后续修正静默 no-op**
-- （例如拿到换算说明后要改 quantity 的 description，会「部署成功但什么都没改」）。
-- 对本迁移自身而言，DO UPDATE 更是**回填已落库行**的唯一手段：213 已先行部署过的环境里
-- 20 行的 source_name 全为 NULL，WHERE NOT EXISTS 会跳过它们 → 视图仍 Binder Error。
ON CONFLICT (dataset_name, name) DO UPDATE SET
  data_type=EXCLUDED.data_type, semantic_group=EXCLUDED.semantic_group,
  is_sensitive=EXCLUDED.is_sensitive, join_to=EXCLUDED.join_to,
  source_name=EXCLUDED.source_name, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

-- ===== 3. 到达守护（data_freshness，runHourlyBucket 每小时）=====
-- 按账套各配一行：合计会被另一账套掩盖，必须分开看（spec §方案3）。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
VALUES
 ('补货到达·3120','data_freshness','replenishment_detail:3120',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1}'::jsonb,
  'high','🔴 [{severity}] 补货数据未到达：{dataset} 账套 {account} 缺 {expect_date} 分区（最新 {have_latest}）',1800,TRUE),
 ('补货到达·64188','data_freshness','replenishment_detail:64188',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1}'::jsonb,
  'high','🔴 [{severity}] 补货数据未到达：{dataset} 账套 {account} 缺 {expect_date} 分区（最新 {have_latest}）',1800,TRUE)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template;
-- ↑ 有意**不**写 `enabled=TRUE`：migrate.sh 每次部署全量重跑全部迁移，若这里强制回 TRUE，
--   则 spec 回滚节那条 `UPDATE monitor_rules SET enabled=false ...` 的应急抑制会在下次部署被**静默撤销**。
--   新行仍由 VALUES 里的 TRUE 正常启用；要**永久**停用则需改本迁移或删除规则行。

-- ===== 4. 行数异常守护（data_volume，runDailyBucket 每日 03:00）=====
-- 类型名用 data_volume 而非 data_integrity：后者的文档原义是「明细 count vs PG 汇总 差异率」（且已被 QA 体系承担），
-- 行数相对中位数偏离是另一根轴（数据量异常），不该占用那个槽位。见 spec §方案3。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
VALUES
 ('补货行数异常·3120','data_volume','replenishment_detail:3120',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1,"median_window":7,"deviation_pct":50,"min_samples":3}'::jsonb,
  'high','🔴 [{severity}] 补货行数异常：{dataset} 账套 {account} {date} 行数 {rows}，近 {window} 日中位数 {median}（偏离 {deviation_pct}%）',1800,TRUE),
 ('补货行数异常·64188','data_volume','replenishment_detail:64188',
  '{"dataset":"replenishment_detail","glob_template":"s3://lemeng-datasource/duckle/lemeng/replenishment_detail/{account}/*/all.parquet","lookback_days":1,"median_window":7,"deviation_pct":50,"min_samples":3}'::jsonb,
  'high','🔴 [{severity}] 补货行数异常：{dataset} 账套 {account} {date} 行数 {rows}，近 {window} 日中位数 {median}（偏离 {deviation_pct}%）',1800,TRUE)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template;
-- ↑ 有意**不**写 `enabled=TRUE`：migrate.sh 每次部署全量重跑全部迁移，若这里强制回 TRUE，
--   则 spec 回滚节那条 `UPDATE monitor_rules SET enabled=false ...` 的应急抑制会在下次部署被**静默撤销**。
--   新行仍由 VALUES 里的 TRUE 正常启用；要**永久**停用则需改本迁移或删除规则行。

COMMIT;
