// web/app/api/admin/push/variables/route.ts
// 推送模板管理页 · 变量点选器数据源（spec §4.1）：
//   /api/push 需服务身份 JWT（verifyServiceJwt），浏览器不可直连——本端点做 admin 代理。
// 鉴权：requireAdmin（会话验签）→ push:configure 闸（uid 取自验签 cookie wecom_userid，绝不读 body/query）。
// 数据：listPushVariables()（push_variables 表，admin-service 已 export；enabled 过滤交页面）。
import { NextRequest, NextResponse } from 'next/server';
import { listPushVariables } from '@/lib/push/admin-service';
import { checkPushPerm } from '@/app/api/push/route';
import { requireAdmin } from '@/lib/admin-api-auth';

export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;
  const uid = req.cookies.get('wecom_userid')?.value ?? '';
  if (!uid) {
    return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
  }
  if (!(await checkPushPerm(uid, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  try {
    const vars = await listPushVariables();
    return NextResponse.json({ ok: true, variables: vars });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
