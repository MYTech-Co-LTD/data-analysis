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

// 配置 JSON 用 createRequire 加载（同 pg 惯例；tsx/node 原生支持 JSON require），
// 用于构建合法检查键集合（--check= 全不匹配时防 CLI 假绿 PASS 0/0）。
const detailSources = require('../services/semantic-generator/src/detail-sources.json') as Array<{ name: string }>;
const qaChecks = require('../services/semantic-generator/src/qa-checks.json') as Array<{ view: string }>;
const validCheckKeys = new Set<string>([
  ...detailSources.map((s) => `D1:${s.name}`),
  ...detailSources.map((s) => `D2:${s.name}`),
  ...qaChecks.map((c) => `C2:${c.view}`),
]);

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

// 与 web/lib/qa-runner.ts 内部 compactDaysAgo 同口径（中国时区 UTC+8 → YYYYMMDD），
// 使 --days=N 真正控制检查窗口（runner 默认固定近 7 天），窗口边界与平台 China-date 约定对齐。
function compactDaysAgo(days: number): string {
  const china = new Date(Date.now() + 8 * 60 * 60 * 1000);
  china.setDate(china.getDate() - days);
  return china.toISOString().slice(0, 10).replace(/-/g, '');
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
  // 逗号两侧去空白 + 过滤空项：--check=D1:retail, D2:retail 不再静默丢掉第二个
  const checks = checksArg
    ? checksArg.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  // 防 CLI 假绿：--check= 给了但无一匹配已知键（D1/D2/C2）→ 本来要跑 0 项，直接报配置错误退出 2
  if (checks && checks.length > 0 && checks.every((c) => !validCheckKeys.has(c))) {
    console.error(`未匹配任何已知检查键: ${checks.join(', ')}`);
    console.error(`合法键示例: ${Array.from(validCheckKeys).join(', ')}`);
    process.exitCode = 2;
    return;
  }

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
  // 随机后缀防同毫秒 run_id 撞 qa_logs UNIQUE 约束
  const runId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
