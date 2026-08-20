// web/app/api/admin/push-presets/route.ts
// 模板库 CRUD（spec §4.3）：push:configure 闸 + card_json 校验 + 引用保护。
// PostgREST 直连模式（照 /api/admin/targets）。
import { NextRequest, NextResponse } from 'next/server';
import { validateCardJson } from '@/lib/push/preset-validate';
// 权限判定复用 /api/push 同一实现（Task 7 决策：export checkPushPerm，禁止复制另一份）
import { checkPushPerm } from '@/app/api/push/route';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET: 模板列表（含引用计数 push_configs(count)）+ order updated_at desc
export async function GET() {
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
  const b = await req.json();
  // 权限闸：操作者身份从 body.userId 取（照 /api/push 的 operator 模式——本路由操作者=登录用户）
  const operatorId = b.userId || '';
  if (!operatorId) return NextResponse.json({ ok: false, error: 'userId required' }, { status: 400 });
  if (!(await checkPushPerm(operatorId, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  if (!b.name || !b.card_json) return NextResponse.json({ ok: false, error: 'name/card_json required' }, { status: 400 });
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
      workflow_id: b.workflow_id || 'scheduled-report',
      msgtype: b.msgtype || 'template_card',
      card_json: b.card_json,
      enabled: b.enabled ?? true,
      updated_by: operatorId,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: `upsert failed: ${r.status}` }, { status: 502 });
  return NextResponse.json({ ok: true, preset_id: presetId });
}

// DELETE: 按 preset_id 删；被 push_configs 引用的模板拒删（引用保护）
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const presetId = url.searchParams.get('preset_id');
  const operatorId = url.searchParams.get('userId') || '';
  if (!presetId || !operatorId) return NextResponse.json({ ok: false, error: 'preset_id/userId required' }, { status: 400 });
  if (!(await checkPushPerm(operatorId, 'push:configure'))) {
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
