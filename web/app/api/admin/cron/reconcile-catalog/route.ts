// web/app/api/admin/cron/reconcile-catalog/route.ts
// Task 6: catalog 对账 cron 手动/外部触发薄壳（03:47 由 in-process scheduler 按 manifest.schedule
// 注册触发——08-15 框架；M16 教训：job 已进 JOBS registry）。与 reconcile-groups 路由同款模式：
//   POST → 跑一轮（resource 注册自愈 → permissions vs catalog 对账 → 红 > 0 企微告警）
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { reconcileCatalogManifest } from '@/lib/jobs/reconcile-catalog/manifest';
import type { JobContext } from '@/lib/contracts';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  // P1 冻结契约：run(ctx) 的 ctx 由宿主注入，job 自含 client 不消费——scheduler.ts hostCtx 同款占位
  const result = await reconcileCatalogManifest.run({} as JobContext);
  return NextResponse.json({ ok: result.status === 'ok', ...result });
}
