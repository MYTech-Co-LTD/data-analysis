// web/app/api/admin/qa-run/route.ts
// 手动/外部触发 QA 运行器（D1/D2/C2 + C0 双向 count），记 qa_logs + 企微告警
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { requireAdmin } from '@/lib/admin-api-auth';
import { runQaChecks } from '@/lib/qa-runner';
import { runC0Checks } from '@/lib/qa/c0-runner';
import { duckQuery } from '@/lib/qa/duck';
import { notifyWecom } from '@/lib/notify';
import type { CheckResult } from '@/lib/qa/types';

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
// PostgREST 直连（gateway 不代理 /rpc，固化 RPC 直连，同 web/lib/scheduler.ts:23）
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const checksParam = url.searchParams.get('check');
  const checks = checksParam ? checksParam.split(',') : undefined;
  const trigger = (url.searchParams.get('trigger') || 'manual') as 'cron' | 'collect' | 'deploy' | 'manual';
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: async (fn: string, body: Record<string, unknown>) => {
      const r = await fetch(`${POSTGREST_URL}/rpc/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) return { error: json };
      return { data: json };
    },
    from: (t: string) => client.database.from(t),
  } as any;
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY, sql);

  const results: CheckResult[] = await runQaChecks({ runId, trigger, db, duck, checks });

  // C0 双向 count（共享执行器，route 与 scheduler 每日 job 共用）——需 token + 源 API，仅 web 上下文可跑
  results.push(...await runC0Checks({ client, duck, runId, trigger, checks }));

  const failed = results.filter((r) => r.status !== 'pass');
  if (failed.length) {
    await notifyWecom('⚠️ 数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 15).map((r) => `${r.check_type}:${r.check_name} ${r.status} diff=${r.diff}`).join('\n')}`).catch(() => {});
  } else {
    await notifyWecom('✅ 数据质量巡检通过', `${results.length} 项全部对齐`).catch(() => {});
  }
  return NextResponse.json({ run_id: runId, total: results.length, failed_count: failed.length, results });
}
