// web/app/api/admin/cron/reconcile-scope-resources/route.ts
// scope_resources 薄同步/对账 cron 入口（03:37 由 in-process scheduler 按 manifest.schedule 注册触发；
//   M16 教训：job 必须进 JOBS registry 才会被注册）。本路由是手动/外部触发薄壳（qa-run 同款鉴权）：
//   POST → 跑一轮薄同步+对账（拉 get-permissions → 逐人 matchRolePermissions → upsert scope_resources
//     → 写 scope_resources_reconcile_history → red>0 企微告警）
//   GET  → 查最近对账 history
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { reconcileScopeResourcesManifest } from '@/lib/jobs/reconcile-scope-resources/manifest';
import type { JobContext } from '@/lib/contracts';
import { INSFORGE_API_BASE, INSFORGE_API_KEY } from '@/lib/jobs/env';
import { createClient } from '@insforge/sdk';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  // P1 冻结契约：run(ctx) 的 ctx 由宿主注入，各 job 现自含 client 不消费——scheduler.ts hostCtx 同款占位
  const result = await reconcileScopeResourcesManifest.run({} as JobContext);
  return NextResponse.json({ ok: result.status === 'ok', ...result });
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data, error } = await client.database
    .from('scope_resources_reconcile_history')
    .select('date,changed,unchanged,empty_keys,red_count')
    .order('date', { ascending: false })
    .limit(7);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, history: data ?? [] });
}
