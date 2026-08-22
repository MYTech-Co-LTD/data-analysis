// web/app/api/admin/push-configs/route.ts
// 推送任务 CRUD（spec §4.3）：admin 闸（requireAdmin 会话身份）+ push:configure 闸 + cron_spec/selector/target 校验 + 启停。
// PostgREST 直连模式（照 /api/admin/push-presets）。
// Review 加固：操作者身份一律取自已验签的会话 cookie（wecom_userid），绝不读 body/query 的 userId（防冒充）。
import { NextRequest, NextResponse } from 'next/server';
// 权限判定复用 /api/push 同一实现（Task 7 决策：export checkPushPerm，禁止复制另一份）
import { checkPushPerm } from '@/app/api/push/route';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// cron_spec/selector/target 校验（spec §4.3）：返回错误文案或 null
function validateSpec(b: Record<string, unknown>): string | null {
  if (!b.name) return 'name required';
  const cs = b.cron_spec as Record<string, unknown> | undefined;
  if (!cs || !['daily', 'weekly', 'monthly'].includes(String(cs.kind))) return 'cron_spec.kind 须为 daily/weekly/monthly';
  // Fix 2b：收紧 HH:mm 合法性（0-23:0-59），拒 99:99 等畸形值（旧正则 \d{2} 只查位数不查范围）
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(cs.time))) return 'cron_spec.time 须为 HH:mm';
  if (cs.kind === 'weekly' && !(Number(cs.weekday) >= 1 && Number(cs.weekday) <= 7)) return 'weekly 须带 weekday 1-7';
  if (cs.kind === 'monthly' && !(Number(cs.day) >= 1 && Number(cs.day) <= 31)) return 'monthly 须带 day 1-31';
  const sel = b.selector as Record<string, unknown> | undefined;
  // role 2026-08-22 启用（U2）：收件人按 roles.id（总经理 boss / 战区总 zone_manager）
  if (!sel || !['dept', 'person', 'role'].includes(String(sel.kind)) || !Array.isArray(sel.ids) || sel.ids.length === 0) {
    return 'selector 须为 dept/person/role + 非空 ids';
  }
  if (b.target_mode === 'fixed' && !b.target_id) return 'fixed 模式 target_id required';
  if (!b.preset_id) return 'preset_id required';
  return null;
}

// GET: 任务列表（字段供任务管理页消费：config_id/name/cron_spec/enabled/selector_json/target_mode/target_id/preset_id/owner_wecom_id/last_run_date/last_run_txn_id）
export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  try {
    const r = await fetch(
      `${POSTGREST_URL}/push_configs?select=*&order=created_at.desc`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `list failed: ${r.status}` }, { status: 502 });
    }
    const data = await r.json().catch(() => []);
    return NextResponse.json({ data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

// POST: 新建/upsert（config_id 缺省新建；带 config_id 走 PATCH 覆盖）
export async function POST(req: NextRequest) {
  // ① admin 闸：JWKS/HS256 验签 insforge_access_token cookie + sub 绑定 wecom_userid + data-analysis:admin
  const deny = await requireAdmin(req);
  if (deny) return deny;
  // ② 操作者身份 = 会话 cookie 的 wecom_userid（验签可信），绝不信任 body 里的 userId
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  // ③ push 功能闸：push:configure
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  const b = await req.json();
  const err = validateSpec(b);
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });

  const body = {
    name: b.name,
    cron_spec: b.cron_spec,
    selector_json: b.selector,
    target_mode: b.target_mode || 'follow',
    target_id: b.target_id ?? null,
    preset_id: b.preset_id,
    owner_wecom_id: uid,
    enabled: b.enabled ?? true,
    updated_at: new Date().toISOString(),
  };
  const r = b.config_id
    ? await fetch(`${POSTGREST_URL}/push_configs?config_id=eq.${b.config_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
    : await fetch(`${POSTGREST_URL}/push_configs`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
  if (!r.ok) return NextResponse.json({ ok: false, error: `upsert failed: ${r.status}` }, { status: 502 });
  const row = b.config_id ? null : (await r.json().catch(() => []))[0];
  return NextResponse.json({ ok: true, config_id: b.config_id || row?.config_id });
}

// PATCH: 启停（?config_id=）——只更新 enabled + updated_at
export async function PATCH(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  const url = new URL(req.url);
  const configId = url.searchParams.get('config_id');
  const b = await req.json();
  if (!configId) return NextResponse.json({ ok: false, error: 'config_id required' }, { status: 400 });
  if (typeof b.enabled !== 'boolean') return NextResponse.json({ ok: false, error: 'enabled 须为 boolean' }, { status: 400 });
  const r = await fetch(
    `${POSTGREST_URL}/push_configs?config_id=eq.${configId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: b.enabled, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: `update failed: ${r.status}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
