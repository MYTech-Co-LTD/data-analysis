// web/app/api/admin/permissions/users/route.ts
// 权限管理：用户列表（含角色）+ 角色指派（manual）/ 恢复自动（auto）
// ⚠️ gateway(7130) 不代理 /rpc 与表接口按既有 admin 路由模式直连 PostgREST
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET: 用户 + 角色 + 部门（页面一次性取齐）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const [u, r, d] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids,role_id,role_source&is_active=eq.true&order=name`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/roles?select=id,code,name&is_active=eq.true&order=sort_order`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/org_departments?select=id,name&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' }),
  ]);
  return NextResponse.json({
    users: await u.json().catch(() => []),
    roles: await r.json().catch(() => []),
    departments: await d.json().catch(() => []),
  });
}

// PUT: 指派角色 { wecom_id, role_id }；role_id=null -> 恢复自动（role_source='auto'，下次同步重算）
export async function PUT(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.wecom_id) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });
  const roleId = b.role_id ?? null;
  const r = await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(b.wecom_id)}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ role_id: roleId, role_source: roleId ? 'manual' : 'auto' }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  return NextResponse.json({ ok: true });
}
