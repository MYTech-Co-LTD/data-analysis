import 'dotenv/config';
import { Pool } from 'pg';
import { readRegistry } from './registry-reader.js';
import type { ViewConfig } from './types.js';

export interface GenResult {
  produced: string[];        // 产出的 .sql 文件名
  explainFailures: string[]; // EXPLAIN 失败的视图名
}

export interface GenOpts {
  client: { query: Function }; // pg PoolClient（测试可 mock）
  viewConfigs: ViewConfig[];
  outDir: string;
}

// P0：读 registry 验证可读，但 Tier1 生成逻辑未实现 → 不产出。
// P1 在此函数里加：按 viewConfig 生成 SQL → EXPLAIN → 写文件。
export async function runGenerator(opts: GenOpts): Promise<GenResult> {
  // 读 registry（验证连通 + L1 自洽由 DB 侧 validate_semantic_registry 保证）
  await readRegistry(opts.client as any);
  // P0：未实现 Tier1 emitter，故无产出
  return { produced: [], explainFailures: [] };
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
      // P0：无 viewConfig（P1 起从 src/view-configs.ts 读）
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

// 只在直接运行时跑 main（被 import 进测试时不跑）
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
