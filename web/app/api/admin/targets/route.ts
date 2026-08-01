// web/app/api/admin/targets/route.ts
// D 目标 CRUD（走 SECURITY DEFINER RPC 绕 RLS）
// ⚠️ gateway(7130) 不代理 /rpc，直连 PostgREST（同 agent-query 的 POSTGREST_URL 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET: 目标列表（admin 视角）→ report_achievement_v 经 RPC。
// 列表只需 total 行；get_targets_admin 返全量含 breakdown(520行/329KB)，过滤 total 减传输，避免刷新闪"暂无目标"。
export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_targets_admin`, {
    method: 'POST', headers, body: '{}',
  });
  const data = await r.json().catch(() => []);
  const totals = (Array.isArray(data) ? data : []).filter((t: any) => t.target_level === 'total');
  return NextResponse.json({ data: totals });
}

// POST: 建总目标（仅名称+周期，函数内硬编码品牌3120+门店ALL）
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.name || !b.start_date || !b.end_date) return NextResponse.json({ ok: false, error: '缺字段' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_target_total`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_id: b.id ?? null, p_name: b.name, p_start: b.start_date, p_end: b.end_date, p_by: b.created_by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
