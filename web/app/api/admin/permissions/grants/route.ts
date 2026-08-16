// web/app/api/admin/permissions/grants/route.ts
// 例外授权管理（Task 17，B5/M3/M4）：temporary_grants 的唯一写入口。
//   GET    → { grants }  活跃全量 + 近30天已失效行（撤销/到期留痕展示）
//   POST   → 授予（requireAdmin 门禁 + 上限校验 + permission_audit 留痕 + 主动失效缓存）
//   DELETE ?id= → 撤销（写 revoked_at + 审计 + invalidateExceptionCache，M3 同步清缓存）
// 上限校验（M4 授予面门禁）：单次到期 ≤90 天；单用户单维活跃例外 ≤50 条。
// PostgREST 调用同本目录 users/route.ts 现有模式（gateway 不代理表接口，直连 + INSFORGE_API_KEY）。
// user_id 语义 = JWT sub（当前 = wecom_id；RLS pre_request 按 claims->>'sub' 精确匹配，改 sub 格式须同步本表）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { writeAudit, actorOf } from '@/lib/permission-audit';
import { invalidateExceptionCache } from '@/lib/exception-grants';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const MAX_DAYS = 90, MAX_PER_DIM = 50, RECENT_DAYS = 30;
const DIMS = new Set(['branch_nums', 'brands', 'categories', 'fields']);

export type GrantRow = {
  id: number; user_id: string; dim: string; value: string;
  expires_at: string; revoked_at: string | null; granted_by: string;
  note: string | null; created_at: string;
};

// GET：活跃全量 + 近30天已失效（已撤销 revoked_at>30d 前、已到期 expires_at>30d 前的不再返回）
export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const r = await fetch(`${POSTGREST_URL}/temporary_grants?select=*&order=id.desc&limit=500`,
    { headers: H, cache: 'no-store' });
  if (!r.ok) return NextResponse.json({ error: `grants ${r.status}` }, { status: 502 });
  const rows = (await r.json().catch(() => [])) as GrantRow[];
  const now = Date.now(), recent = now - RECENT_DAYS * 86_400_000;
  const grants = (Array.isArray(rows) ? rows : []).filter((g) => {
    const exp = new Date(g.expires_at).getTime(), rev = g.revoked_at ? new Date(g.revoked_at).getTime() : null;
    const active = rev == null && exp > now;                       // 活跃
    const recentlyRevoked = rev != null && rev > recent;           // 近30天撤销
    const recentlyExpired = rev == null && exp <= now && exp > recent; // 近30天到期
    return active || recentlyRevoked || recentlyExpired;
  });
  return NextResponse.json({ grants });
}

// POST：授予 { wecom_id, dim, value, expires_at, note? }
export async function POST(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.wecom_id || !DIMS.has(b.dim) || !b.value || !b.expires_at) {
    return NextResponse.json({ error: 'dim/value/wecom_id/expires_at 必填且 dim 合法' }, { status: 400 });
  }
  if (typeof b.value !== 'string' || !b.value.trim()) {
    return NextResponse.json({ error: 'value 必须为非空字符串' }, { status: 400 });
  }
  // 字段维当前只有 cost（catalog data-analysis:field:cost）；其余字段值属越权面，拒之
  if (b.dim === 'fields' && b.value !== 'cost') {
    return NextResponse.json({ error: "fields 维当前仅支持 value='cost'" }, { status: 400 });
  }
  const expMs = new Date(b.expires_at).getTime();
  if (!Number.isFinite(expMs)) {
    return NextResponse.json({ error: 'expires_at 须为合法时间' }, { status: 400 });
  }
  const days = Math.ceil((expMs - Date.now()) / 86_400_000);
  if (!(days > 0 && days <= MAX_DAYS)) {
    return NextResponse.json({ error: `到期天数须在 (0, ${MAX_DAYS}]` }, { status: 400 });
  }

  // 上限：单用户单维活跃例外 ≤ MAX_PER_DIM（M4 授予面门禁）
  const nowIso = new Date().toISOString();
  const cnt = await fetch(
    `${POSTGREST_URL}/temporary_grants?select=id&user_id=eq.${encodeURIComponent(b.wecom_id)}` +
    `&dim=eq.${b.dim}&revoked_at=is.null&expires_at=gt.${nowIso}`,
    { headers: H, cache: 'no-store' });
  if (cnt.ok) {
    const cur = await cnt.json().catch(() => []);
    if (Array.isArray(cur) && cur.length >= MAX_PER_DIM) {
      return NextResponse.json(
        { error: `该用户此维度活跃例外已达上限 ${MAX_PER_DIM} 条，请先撤销或等待到期` }, { status: 409 });
    }
  }

  const actor = actorOf(req);
  const body = {
    user_id: b.wecom_id, dim: b.dim, value: b.value.trim(),
    expires_at: new Date(expMs).toISOString(),
    granted_by: actor.wecom_id, note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
  };
  const ins = await fetch(`${POSTGREST_URL}/temporary_grants`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  if (!ins.ok) {
    const detail = await ins.text().catch(() => '');
    return NextResponse.json({ error: `授予失败 ${ins.status} ${detail.slice(0, 200)}` }, { status: 502 });
  }
  const inserted = (await ins.json().catch(() => null)) as GrantRow[] | null;
  const grant = inserted?.[0] ?? { ...body, id: -1, revoked_at: null, created_at: nowIso };
  await writeAudit(req, {
    action: 'grant_create', subjectType: 'user', subjectId: b.wecom_id,
    before: null, after: grant,
  });
  invalidateExceptionCache(b.wecom_id);   // 新授予立即可见（M3 主动失效，不只撤销侧）
  return NextResponse.json({ ok: true, grant });
}

// DELETE ?id=：撤销（幂等方向安全——revoked_at 已置的行不再命中，返回 404）
export async function DELETE(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id 必须为数字' }, { status: 400 });
  }
  const upd = await fetch(
    `${POSTGREST_URL}/temporary_grants?id=eq.${id}&revoked_at=is.null`,
    {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
  if (!upd.ok) {
    const detail = await upd.text().catch(() => '');
    return NextResponse.json({ error: `撤销失败 ${upd.status} ${detail.slice(0, 200)}` }, { status: 502 });
  }
  const rows = (await upd.json().catch(() => null)) as GrantRow[] | null;
  const row = rows?.[0];
  if (!row) return NextResponse.json({ error: '例外不存在或已撤销' }, { status: 404 });
  await writeAudit(req, {
    action: 'grant_revoke', subjectType: 'user', subjectId: row.user_id,
    before: row, after: { ...row, revoked_at: new Date().toISOString() },
  });
  invalidateExceptionCache(row.user_id);   // M3：撤销 ≤5min 生效（健康态即时）
  return NextResponse.json({ ok: true });
}
