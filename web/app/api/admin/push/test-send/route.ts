// web/app/api/admin/push/test-send/route.ts
// 推送模板管理页 · 测试发送（spec §4.3：服务端强制 selector=操作者本人，不信任前端传入）：
//   直接调引擎 runPush（deliver=true）发到操作者自己企微，走完整链路（渲染→Novu→bridge）。
//   绝不读 body 里的 selector/userId——收件人恒为会话 cookie 验签的 wecom_userid。
// 鉴权：requireAdmin（会话验签）→ push:configure 闸。
import { NextRequest, NextResponse } from 'next/server';
import { runPush } from '@/lib/push';
import { checkPushPerm } from '@/app/api/push/route';
import { requireAdmin } from '@/lib/admin-api-auth';

export async function POST(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  if (!uid) {
    return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
  }
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }

  let presetId: string;
  try {
    const body = (await req.json()) as { presetId?: string };
    presetId = body?.presetId ?? '';
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!presetId) {
    return NextResponse.json({ ok: false, error: 'presetId required' }, { status: 400 });
  }

  try {
    // 服务端强制收件人 = 操作者本人（会话身份），never from body；selector 仅本人 → 非广播
    const r = await runPush({
      workflowId: 'scheduled-report',
      presetId,
      selector: { kind: 'person', ids: [uid] },
      operatorId: uid,
      broadcastPerm: false,
      deliver: true,
    });
    if (r.error) {
      // 引擎返回业务错误（如暂停/无有效收件人）→ 502 透传
      return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
    }
    return NextResponse.json({ ok: true, txnId: r.txnId, groups: r.groups });
  } catch (e) {
    // M7 fail-closed 守卫等抛错（未解析变量占位符 live 拒投）→ 502
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
