import 'dotenv/config';
import { Pool } from 'pg';
import { readRegistry } from './registry-reader.js';
import { generateTier1View } from './generators/tier1.js';
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

// P1：Tier1 生成器
export async function runGenerator(opts: GenOpts): Promise<GenResult> {
  const { metrics, sources } = await readRegistry(opts.client as any);

  const produced: string[] = [];
  const explainFailures: string[] = [];

  for (const config of opts.viewConfigs) {
    try {
      const sql = generateTier1View(config, metrics, sources);
      produced.push(config.view_name);
    } catch (err) {
      explainFailures.push(config.view_name);
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
      // P1：viewConfigs 从参数传入（后续从 src/view-configs.ts 读）
      const r = await runGenerator({ client, viewConfigs: [], outDir: '../../database/generated' });
      console.log(`✅ 生成器完成：产出 ${r.produced.length} 个视图，EXPLAIN 失败 ${r.explainFailures.length} 个`);
      if (r.explainFailures.length) {
        console.error('  失败：', r.explainFailures.join(', '));
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
