// web/app/api/admin/push-presets/route.ts
// 模板库 CRUD（spec §4.3）：admin 闸（requireAdmin 会话身份）+ push:configure 闸 + card_json 校验 + 引用保护。
// PostgREST 直连模式（照 /api/admin/targets）。
// Review 加固：操作者身份一律取自已验签的会话 cookie（wecom_userid），绝不读 body/query 的 userId（防冒充）。
import { NextRequest, NextResponse } from 'next/server';
import { validateCardJson } from '@/lib/push/preset-validate';
// 权限判定复用 /api/push 同一实现（Task 7 决策：export checkPushPerm，禁止复制另一份）
import { checkPushPerm } from '@/app/api/push/route';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET: 模板列表（含引用计数 push_configs(count)）+ order updated_at desc
// 鉴权：requireAdmin（data-analysis:admin）——列表为模板只读视图，admin 框架闸即可。
export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  try {
    const r = await fetch(
      `${POSTGREST_URL}/push_message_presets?select=*,push_configs(count)&order=updated_at.desc`,
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

// POST: 新建/upsert（preset_id 缺省自动生成，workflow_id 用兼容占位 'scheduled-report'）
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
  if (!b.name || !b.card_json) return NextResponse.json({ ok: false, error: 'name/card_json required' }, { status: 400 });
  // msgtype 收敛：自助模板库仅 template_card（text/markdown 为 legacy 兼容路径，不开放）
  if (b.msgtype !== undefined && b.msgtype !== 'template_card') {
    return NextResponse.json({ ok: false, error: 'msgtype 仅支持 template_card' }, { status: 400 });
  }
  const v = validateCardJson(b.card_json);
  if (!v.ok) return NextResponse.json({ ok: false, error: 'card_json 校验失败', detail: v.errors }, { status: 400 });

  const presetId = b.preset_id || `preset-${Date.now().toString(36)}`;
  const r = await fetch(`${POSTGREST_URL}/push_message_presets`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      preset_id: presetId,
      name: b.name,
      // workflow_id 列 NOT NULL（legacy）——新建模板用 'scheduled-report' 兼容占位
      workflow_id: 'scheduled-report',
      msgtype: 'template_card',
      card_json: b.card_json,
      enabled: b.enabled ?? true,
      updated_by: uid,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: `upsert failed: ${r.status}` }, { status: 502 });
  return NextResponse.json({ ok: true, preset_id: presetId });
}

// DELETE: 按 preset_id 删；被 push_configs 引用的模板拒删（引用保护）
export async function DELETE(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  const url = new URL(req.url);
  const presetId = url.searchParams.get('preset_id');
  if (!presetId) return NextResponse.json({ ok: false, error: 'preset_id required' }, { status: 400 });
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  // 引用保护：被任务引用的模板不可删
  const refs = await fetch(
    `${POSTGREST_URL}/push_configs?preset_id=eq.${encodeURIComponent(presetId)}&select=config_id`,
    { headers, signal: AbortSignal.timeout(8000) },
  );
  const refRows = await refs.json().catch(() => []);
  if (Array.isArray(refRows) && refRows.length > 0) {
    return NextResponse.json({ ok: false, error: `该模板被 ${refRows.length} 个推送任务引用，不可删除` }, { status: 409 });
  }
  const r = await fetch(
    `${POSTGREST_URL}/push_message_presets?preset_id=eq.${encodeURIComponent(presetId)}`,
    { method: 'DELETE', headers, signal: AbortSignal.timeout(8000) },
  );
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: `delete failed: ${r.status}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
