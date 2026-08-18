// scripts/tests/consumption-switch.test.mjs
// H7 衍生列血缘断言（Task 16 消费侧切，plan L1675-1703 基线）：
//   fields.cost=false（或缺失）→ 成本基列 NULL 且 margin 类衍生列全随 NULL——
//   防 inner CTE 单独产出再外层投影漏掩。注入式直查生成视图（psql superuser 连接，
//   RLS 不参与，聚焦列掩码判定链路 can_cost_visible()）。
//
// 与 plan 基线的三处事实性适配（仓库实况，记录于 task report）：
//   ① 实际视图无通用 cost/profit/margin 列：item 视图掩码列 = sale/delivery/wholesale/outbound_profit，
//      brand 视图含基列 delivery_profit + 衍生列 delivery_margin（margin 血缘断言最佳载体）；
//   ② psql -tA 会回显 BEGIN/set_config/INSERT/ROLLBACK 噪声 → -q + DO PERFORM set_config，
//      输出仅剩被测 SELECT 的单行结果；
//   ③ dev 库无业务数据（targets/dim_* 全空）→ 事务内 seed 最小 fixture，ROLLBACK 自动清理
//      （零残留、可重复跑，不依赖环境数据）。
//   ④ T19 后视图行过滤 = scope_match_v2（185 终版语义）：data_scope 维度段缺失（旧形状令牌）
//      = deny → 空视图。fixture claims 须为新形状全维令牌（claims.js B1「三维恒存在」）：
//      brands 用值匹配 '3120' 对齐 fixture 品牌（兼测 value 匹配分支），branch_nums/categories
//      用通配。缺段修复前第 1/3 例在空视图上空洞通过（count=0 恒真），已加「行过滤放行」
//      前置断言恢复断言力。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// SQL 经 stdin 传入（-f -）：绕开 shell 双引号内的 $$/变量展开（DO $$ 块曾被展开成 PID）。
// ON_ERROR_STOP=1：fixture/查询任一语句报错即整体非零退出——防空串被 notEqual 类断言吞成假绿。
const PSQL = (sql) => execSync(
  'docker exec -i deploy-postgres-1 psql -U postgres -d insforge -q -tA -v ON_ERROR_STOP=1 -f -',
  { encoding: 'utf8', input: sql },
).trim();

// 最小 fixture：1 个 total 级 active 目标（窗口=今天）+ 战区/门店/品牌/商品维 + 三张事实行。
// 全部在 BEGIN...ROLLBACK 事务内执行，跑完即回滚。维表用 upsert——dev 库 dim_brand 等已有
// 环境预置行（如 3120），DO UPDATE 把视图 join 依赖的键值钉成测试所需（回滚即还原）。
const FIXTURE = `INSERT INTO dim_war_zone(war_zone, is_assessed) VALUES ('东', true) ON CONFLICT (war_zone) DO UPDATE SET is_assessed = true;
INSERT INTO dim_branch(system_book_code, branch_num, is_active, first_level_region) VALUES ('3120', '001', true, '东') ON CONFLICT (system_book_code, branch_num) DO UPDATE SET is_active = true, first_level_region = '东';
INSERT INTO dim_brand(system_book_code, brand_name, enabled) VALUES ('3120', '熊喵鲜生-fixture', true) ON CONFLICT (system_book_code) DO NOTHING;
INSERT INTO dim_item(system_book_code, item_num, item_code, is_active, item_name, category_name, top_category, item_brand) VALUES ('3120', '90001', 'X-90001', true, 't16商品', '水果', '水果', 't16品牌') ON CONFLICT (system_book_code, item_num) DO UPDATE SET item_code = 'X-90001', is_active = true;
INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, target_level, status) VALUES ('t16-fixture', '3120', 'ALL', current_date, current_date, 'total', 'active');
INSERT INTO report_daily_item_sales(biz_date, system_book_code, item_num, sale_amount, sale_profit) VALUES (current_date, '3120', '90001', 100.00, 20.00) ON CONFLICT DO NOTHING;
INSERT INTO report_daily_item_outbound(biz_date, system_book_code, item_num, pos_item_code, delivery_amount, delivery_profit, wholesale_amount, wholesale_profit) VALUES (current_date, '3120', '90001', 'X-90001', 60.00, 8.00, 20.00, 2.00) ON CONFLICT DO NOTHING;
INSERT INTO report_daily_delivery(biz_date, system_book_code, branch_num, category_group, out_money, profit_money) VALUES (current_date, '3120', '001', '水果', 80.00, 10.00) ON CONFLICT DO NOTHING;`;

const withClaims = (claims, sql) => PSQL(
  `BEGIN; DO $$ BEGIN PERFORM set_config('request.jwt.claims', '${JSON.stringify(claims).replace(/'/g, "''")}', true); END $$; ${FIXTURE} ${sql}; ROLLBACK;`);

// 新形状全维 data_scope（T19/185 后行过滤 scope_match_v2 的放行前提）：brands 值匹配 '3120'
// = fixture 事实行的 system_book_code；branch_nums/categories 通配。三维缺一 = 旧形状令牌 = deny。
const SCOPE = { branch_nums: ['*'], brands: ['3120'], categories: ['*'] };

test('红→绿：fields.cost 缺失（无 fields 段）→ 全掩（安全方向不依赖单处 CASE）', () => {
  const claims = { sub: 'shanhai/test', data_scope: SCOPE };
  const total = withClaims(claims, `SELECT count(*) FROM report_item_breakdown_gen`);
  assert.notEqual(total, '0');   // 前置：行过滤放行 fixture 行（brands 值匹配）——防空视图把掩码断言空洞化
  const r = withClaims(claims,
    `SELECT count(*) FROM report_item_breakdown_gen WHERE sale_profit IS NOT NULL OR delivery_profit IS NOT NULL OR wholesale_profit IS NOT NULL OR outbound_profit IS NOT NULL`);
  assert.equal(r, '0');   // 四个成本基列全 NULL（fields 段缺失 = 不见成本，新令牌安全方向）
});

test('红→绿：fields.cost=true → 成本列可见', () => {
  const r = withClaims({ sub: 'shanhai/test', data_scope: SCOPE, fields: { cost: true } },
    `SELECT count(*) FROM report_item_breakdown_gen WHERE sale_profit IS NOT NULL AND outbound_profit IS NOT NULL`);
  assert.notEqual(r, '0');
});

test('血缘：margin/rate 类衍生列随基列 NULL（非独立产出）', () => {
  const claims = { sub: 'shanhai/test', data_scope: SCOPE };
  const flowed = withClaims(claims,
    `SELECT count(*) FROM report_brand_metric_gen WHERE delivery_amount > 0 AND delivery_profit IS NULL AND delivery_margin IS NULL`);
  assert.notEqual(flowed, '0');  // 前置：fixture 配送行穿过行过滤（delivery_amount>0）且成本列被掩——空视图/行过滤误拒在此爆红
  const r = withClaims(claims,
    `SELECT count(*) FROM report_brand_metric_gen WHERE delivery_profit IS NULL AND delivery_margin IS NOT NULL`);
  assert.equal(r, '0');   // cost 被掩则 margin 必 NULL——inner CTE 漏掩在此爆红
});
