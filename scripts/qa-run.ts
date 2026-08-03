#!/usr/bin/env node
// scripts/qa-run.ts — 本地/运维手动跑 QA（D1/D2/C2），tsx 执行
// 用法：npx tsx scripts/qa-run.ts [--check=D1:retail] [--days=7]
// 环境变量：DATABASE_URL、DUCKDB_URL(默认 http://localhost:9000)、AGENT_API_KEY
// 退出码：0=全部通过  1=有失败/错误  2=配置错误/运行异常
import { createRequire } from 'node:module';
import { runQaChecks } from '../web/lib/qa-runner';
import { duckQuery } from '../web/lib/qa/duck';

// pg 从共享依赖目录解析（同 scripts/reconcile-check.js / generate-views.js 惯例），
// 不依赖仓库根 node_modules 预装（根无 package.json，node_modules/ 全部 gitignore）。
const require = createRequire(import.meta.url);
function loadPg(): any {
  for (const p of ['../services/node_modules/pg', '../node_modules/pg']) {
    try {
      return require(p);
    } catch {
      // 尝试下一处
    }
  }
  return require('pg'); // 兜底：已装到 scripts/ 或仓库根 node_modules
}
const pg = loadPg();

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

// 与 web/lib/qa-runner.ts 内部 compactDaysAgo 同口径（UTC→YYYYMMDD），
// 使 --days=N 真正控制检查窗口（runner 默认固定近 7 天）
function compactDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('缺 DATABASE_URL'); process.exitCode = 2; return; }
  const duckUrl = process.env.DUCKDB_URL || 'http://localhost:9000';
  const apiKey = process.env.AGENT_API_KEY || '';
  const daysRaw = parseInt(arg('days') || '7', 10);
  if (!Number.isFinite(daysRaw) || daysRaw < 1) { console.error(`--days 无效（${arg('days') ?? '空'}），用默认 7`); process.exitCode = 2; return; }
  const days = daysRaw;
  const checksArg = arg('check');
  const checks = checksArg ? checksArg.split(',') : undefined;

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const db = {
    // qa_d2_dup_rows(TEXT, TEXT[])：p_table 单引号内必须转义；p_keys 拼 ARRAY 字面量
    rpc: async (fn: string, body: Record<string, unknown>) => {
      const tbl = String(body.p_table).replace(/'/g, "''");
      const keys = (body.p_keys as string[]).map((k) => `'${k.replace(/'/g, "''")}'`).join(', ');
      const r = await client.query(`SELECT * FROM ${fn}('${tbl}', ARRAY[${keys}]::text[])`);
      return { data: r.rows };
    },
    from: (t: string) => ({
      select: async (cols: string) => {
        const r = await client.query(`SELECT ${cols} FROM ${t}`);
        return { data: r.rows };
      },
      insert: async (rows: unknown[]) => {
        for (const row of rows as Record<string, unknown>[]) {
          await client.query(
            `INSERT INTO ${t} (run_id, trigger, check_type, check_name, status, diff, detail) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [row.run_id, row.trigger, row.check_type, row.check_name, row.status, row.diff ?? null, row.detail ? JSON.stringify(row.detail) : null],
          );
        }
        return { data: rows };
      },
    }),
  } as any;

  const duck = (sql: string) => duckQuery(duckUrl, apiKey, sql);
  const runId = `cli-${Date.now()}`;
  const results = await runQaChecks({
    runId,
    trigger: 'manual',
    db,
    duck,
    checks,
    dateFrom: compactDaysAgo(days - 1),
    dateTo: compactDaysAgo(0),
  });

  await client.end();
  const failed = results.filter((r) => r.status !== 'pass');
  results.forEach((r) => console.log(`[${r.check_type}:${r.check_name}] ${r.status}${r.diff != null ? ` diff=${r.diff}` : ''}`));
  console.log(failed.length ? `FAIL ${failed.length}/${results.length}` : `PASS ${results.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
