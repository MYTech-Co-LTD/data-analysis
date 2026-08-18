import 'dotenv/config';
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readRegistry } from './registry-reader.js';
import { generateTier1View } from './generators/tier1.js';
import { generateHierarchyView } from './generators/hierarchy.js';
import { generateQaView } from './generators/qa.js';
import qaChecks from './qa-checks.json';
import type { ViewAssertion } from './qa-types.js';
import { explainSql } from './explain.js';
import type { ViewConfig } from './types.js';

export interface GenResult {
  produced: string[];
  explainFailures: string[];
  assertionFailures: string[];   // L4 C2：视图↔聚合对账断言 diff>容差
  rollupFailures: string[];      // L4 C3：层级视图 rollup 自洽 pivot 校验 diff>容差
}

// L4 C3：层级视图 rollup 自洽 pivot（同 web/lib/qa/c3-runner.ts 语义——SQL 内联，不跨包 import）。
// 对 level 列 pivot：SUM(level='region') vs SUM(level='sub_region') vs SUM(level='store')，
// |diff|>容差 记 mismatch（战区和=小区和=门店和）。生成视图 level 列字面量即契约。
export const C3_TOLERANCE = 0.01;
export const C3_ROLLUP_VIEWS: { view: string; metrics: string[] }[] = [
  { view: 'report_region_breakdown_gen', metrics: ['sale_actual', 'delivery_actual'] },
  { view: 'report_supply_chain_outbound_gen', metrics: ['delivery_amount'] },
];

export function buildRollupPivotSql(view: string, metric: string): string {
  // PG HAVING 不能引用 SELECT 别名（region_total 等），须外包一层子查询再 WHERE 过滤。
  // 语义同 web/lib/qa/c3-runner.ts（region/sub_region/store SUM 差>容差报 mismatch）。
  return `SELECT * FROM (
    SELECT target_id,
      SUM(CASE WHEN level='region' THEN ${metric} END) AS region_total,
      SUM(CASE WHEN level='sub_region' THEN ${metric} END) AS sub_region_total,
      SUM(CASE WHEN level='store' THEN ${metric} END) AS store_total
    FROM ${view}
    GROUP BY target_id
  ) t WHERE ABS(region_total - sub_region_total) > ${C3_TOLERANCE} OR ABS(region_total - store_total) > ${C3_TOLERANCE}`;
}

// 对已产出视图跑 C3 pivot；返回 rollupFailures 行描述。本次未产出（如单视图测试/EXPLAIN 失败）则跳过。
export async function runRollupChecks(client: { query: Function }, produced: string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const cfg of C3_ROLLUP_VIEWS) {
    if (!produced.includes(cfg.view)) continue;
    for (const metric of cfg.metrics) {
      try {
        const r = await client.query(buildRollupPivotSql(cfg.view, metric));
        for (const row of r.rows) {
          failures.push(
            `${cfg.view}.${metric} target_id=${row.target_id}: region ${row.region_total} vs sub_region ${row.sub_region_total} vs store ${row.store_total} (rollup 差>${C3_TOLERANCE})`,
          );
        }
      } catch (e) {
        failures.push(`${cfg.view}.${metric} C3 pivot 查询失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return failures;
}

export interface GenOpts {
  client: { query: Function };
  viewConfigs: ViewConfig[];
  outDir: string;
}

// P1：Tier1 生成器 + L2 EXPLAIN + 写文件
export async function runGenerator(opts: GenOpts): Promise<GenResult> {
  const { metrics, sources } = await readRegistry(opts.client as any);

  const produced: string[] = [];
  const explainFailures: string[] = [];
  const assertionFailures: string[] = [];

  mkdirSync(opts.outDir, { recursive: true });

  for (const config of opts.viewConfigs) {
    try {
      // Category dimension → special handling
      // hierarchy config → 多级 UNION ALL 视图（下钻表）；否则 Tier1 单级
      const sql = config.dim_code === 'category'
        ? generateHierarchyView(config, metrics, sources)
        : config.hierarchy
          ? generateHierarchyView(config, metrics, sources)
          : generateTier1View(config, metrics, sources);

      // L2 EXPLAIN：先建视图再 EXPLAIN SELECT
      try {
        await opts.client.query(sql); // DROP + CREATE
        const r = await explainSql(opts.client as any, `SELECT * FROM ${config.view_name}`);
        if (!r.ok) {
          explainFailures.push(`${config.view_name}: ${r.error}`);
          continue;
        }
      } catch (e) {
        explainFailures.push(`${config.view_name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // 写文件
      const file = join(opts.outDir, `${config.view_name}.sql`);
      writeFileSync(file, sql + '\n');
      produced.push(config.view_name);

      // L4 C2：该视图有断言则产 ${view}_qa 对账视图（静态 SQL，migrate 幂等应用）
      const viewAssertions = (qaChecks as ViewAssertion[]).filter((a) => a.view === config.view_name);
      if (viewAssertions.length) {
        const qaSql = generateQaView(viewAssertions);
        const qaFile = join(opts.outDir, `${config.view_name}_qa.sql`);
        writeFileSync(qaFile, qaSql + '\n');
      }

      // L4 C2：gen 后立即跑断言（视图↔聚合表 SUM 对账），防上线即回归
      if (viewAssertions.length) {
        try {
          // 先建 _qa 视图（runGenerator 顶部只建了主视图，_qa 未入 DB）
          await opts.client.query(generateQaView(viewAssertions));
          const qaRows = await opts.client.query(
            `SELECT metric, view_sum, ref_sum, diff FROM ${config.view_name}_qa WHERE ABS(diff) > $1`,
            [0.01],
          );
          for (const row of qaRows.rows) {
            assertionFailures.push(
              `${config.view_name}.${row.metric}: 视图 ${row.view_sum} vs 上游 ${row.ref_sum} (diff ${row.diff})`,
            );
          }
        } catch (e) {
          assertionFailures.push(`${config.view_name}_qa 断言查询失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (err) {
      explainFailures.push(`${config.view_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // L4 C3：gen 后立即跑层级视图 rollup 自洽 pivot（2 张层级视图，level 列 region/sub_region/store SUM 差>容差 报错），
  // 防生成器改动导致上下钻对不上（同 C2 即时断言，exit 1 阻断）。
  const rollupFailures = await runRollupChecks(opts.client, produced);

  return { produced, explainFailures, assertionFailures, rollupFailures };
}

// CLI 入口：npm run gen-views
export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ 缺 DATABASE_URL（见 .env.example）');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    const client = await pool.connect();
    try {
      const { brandMetricView, categorySummaryView, regionBreakdownView, itemBreakdownView, wholesaleCustomerView, supplyChainOutboundView, wholesaleDailyView, wholesaleDailyCustomerView } = await import('./view-configs.js');
      const r = await runGenerator({ client, viewConfigs: [brandMetricView, categorySummaryView, regionBreakdownView, itemBreakdownView, wholesaleCustomerView, supplyChainOutboundView, wholesaleDailyView, wholesaleDailyCustomerView], outDir: '../../database/generated' });
      console.log(`✅ 生成器完成：产出 ${r.produced.length} 个视图，EXPLAIN 失败 ${r.explainFailures.length} 个，断言失败 ${r.assertionFailures.length} 个，rollup 失败 ${r.rollupFailures.length} 个`);
      if (r.produced.length) console.log('  产出:', r.produced.join(', '));
      if (r.rollupFailures.length === 0) console.log('  C3 rollup 自洽: 通过（region/sub_region/store SUM 差≤0.01）');
      const allFails = [...r.explainFailures, ...r.assertionFailures, ...r.rollupFailures];
      if (allFails.length) {
        console.error('  失败:');
        allFails.forEach((f) => console.error('   -', f));
        process.exit(1);
      }

      // 达成视图（target×metric 矩阵）：独立生成器 + EXPLAIN + 写文件（迁移 118 total 级口径收口语义层）
      const { achievementViewConfig } = await import('./achievement-config.js');
      const { generateAchievementView } = await import('./generators/achievement.js');
      try {
        const achSql = generateAchievementView(achievementViewConfig);
        await client.query(achSql);  // DROP+CREATE in DB（gen 期建好，EXPLAIN + 契约）
        const achExplain = await explainSql(client, `SELECT * FROM ${achievementViewConfig.view_name}`);
        if (!achExplain.ok) {
          console.error(`  - ${achievementViewConfig.view_name} EXPLAIN 失败: ${achExplain.error}`);
          process.exit(1);
        }
        const achFile = join('../../database/generated', `${achievementViewConfig.view_name}.sql`);
        writeFileSync(achFile, achSql + '\n');
        console.log(`  产出: ${achievementViewConfig.view_name}`);

        // L4 C2：达成视图也产 _qa 对账视图（静态 SQL 入 database/generated，migrate 幂等应用）+ gen 后即时断言。
        // 长表（每行 target×metric）：view_sum = SUM(actual_value) WHERE metric_code + status='active'
        //   （closed snapshot 行被 status='active' 排除），ref_sql 独立重算 active total 周期明细，同 runGenerator L72-89 模式。
        const achAssertions = (qaChecks as ViewAssertion[]).filter((a) => a.view === achievementViewConfig.view_name);
        if (achAssertions.length) {
          const achQaSql = generateQaView(achAssertions);
          const achQaFile = join('../../database/generated', `${achievementViewConfig.view_name}_qa.sql`);
          writeFileSync(achQaFile, achQaSql + '\n');
          await client.query(achQaSql); // 建 _qa 视图（gen 期建好，供即时断言）
          const achQaRows = await client.query(
            `SELECT metric, view_sum, ref_sum, diff FROM ${achievementViewConfig.view_name}_qa WHERE ABS(diff) > $1`,
            [0.01],
          );
          if (achQaRows.rows.length) {
            console.error(`  - ${achievementViewConfig.view_name} 断言失败:`);
            for (const row of achQaRows.rows) {
              console.error(`    - ${row.metric}: 视图 ${row.view_sum} vs 上游 ${row.ref_sum} (diff ${row.diff})`);
            }
            process.exit(1);
          }
          console.log(`  产出: ${achievementViewConfig.view_name}_qa`);
        }
      } catch (e) {
        console.error(`  - ${achievementViewConfig.view_name} 生成失败: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
