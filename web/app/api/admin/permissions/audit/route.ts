// web/app/api/admin/permissions/audit/route.ts
// 权限变更审计列表：GET /audit?limit=50（默认 50，上限 200；created_at desc, id desc 倒序）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 50) || 50, 200);
  const r = await fetch(`${POSTGREST_URL}/permission_audit?select=id,actor_wecom_id,actor_name,action,subject_type,subject_id,payload_before,payload_after,created_at&order=created_at.desc,id.desc&limit=${limit}`, { headers: H, cache: 'no-store' });
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  const items = await r.json();
  return NextResponse.json({ items: Array.isArray(items) ? items : [] });
}
