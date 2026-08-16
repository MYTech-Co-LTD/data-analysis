// web/app/api/admin/cron/reconcile-groups/route.ts
// Task 10: 每日组对账 cron 入口（03:37 由 in-process scheduler 按 manifest.schedule 注册触发——08-15 框架；
// M16 教训：job 必须进 JOBS registry 才会被注册）。本路由是手动/外部触发薄壳（qa-run 同款鉴权）：
//   POST → 跑一轮对账（拉期望源/实际集 → diff → UPSERT group_reconcile_history → red>0 企微告警）
//   GET  → 查 7 天门禁状态（gate7days，W2 退出判据 M4）
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { requireAdmin } from '@/lib/admin-api-auth';
import { reconcileGroupsManifest } from '@/lib/jobs/reconcile-groups/manifest';
import type { JobContext } from '@/lib/contracts';
import { gate7days } from '@/lib/reconcile-groups';
import { INSFORGE_API_BASE, INSFORGE_API_KEY } from '@/lib/jobs/env';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  // P1 冻结契约：run(ctx) 的 ctx 由宿主注入，各 job 现自含 client 不消费——scheduler.ts hostCtx 同款占位
  const result = await reconcileGroupsManifest.run({} as JobContext);
  return NextResponse.json({ ok: result.status === 'ok', ...result });
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data, error } = await client.database
    .from('group_reconcile_history')
    .select('date,whitelist_outside_diff,red_count,detail')
    .order('date', { ascending: false })
    .limit(7);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as {
    date: string; whitelist_outside_diff: number; red_count: number;
  }[];
  const week = rows
    .map((h) => ({ whitelistOutsideDiff: h.whitelist_outside_diff, redCount: h.red_count }))
    .reverse();
  return NextResponse.json({
    ok: true,
    gate7days: gate7days(week),
    history: rows,
  });
}
