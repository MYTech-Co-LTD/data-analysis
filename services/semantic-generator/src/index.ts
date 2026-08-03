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
    } catch (err) {
      explainFailures.push(`${config.view_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { produced, explainFailures };
}

// CLI 入口：npm run gen-views
async function main() {
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
      console.log(`✅ 生成器完成：产出 ${r.produced.length} 个视图，EXPLAIN 失败 ${r.explainFailures.length} 个`);
      if (r.produced.length) console.log('  产出:', r.produced.join(', '));
      if (r.explainFailures.length) {
        console.error('  失败:');
        r.explainFailures.forEach(f => console.error('   -', f));
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
