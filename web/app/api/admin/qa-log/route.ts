// web/app/api/admin/qa-log/route.ts
// F6: QA 结果只读摘要——qa_logs 最近 N 条前端可见（D1/D2/C0/C1/C2/C3 巡检结果不再 write-only）
// 复用 qa-run/route.ts 的 PostgREST 直连（gateway 不代理 /rpc 与表接口）+ requireAdmin 鉴权
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/qa-log?status=fail&limit=20
//  status=fail → 只显示 fail/error；默认最近 20 条全状态
//  limit 覆盖条数（默认 20，上限 100，防一次拉全表）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req);
  if (deny) return deny;

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const limitRaw = Number(url.searchParams.get('limit') || 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 100) : 20;

  let qs = `select=*&order=run_at.desc&limit=${limit}`;
  if (status === 'fail') qs += '&status=in.(fail,error)';

  const r = await fetch(`${POSTGREST_URL}/qa_logs?${qs}`, { headers: H, cache: 'no-store' });
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: `qa_logs query ${r.status}: ${await r.text()}` }, { status: 502 });
  }
  const data = await r.json();
  return NextResponse.json({ ok: true, data });
}
