// web/lib/admin-api-auth.ts
// /api/admin/** 路由内鉴权（middleware matcher 不盖 /api/**，必须路由内自查）
// 强度与 middleware 的 /admin 页面门一致：insforge_access_token 存在 + wecom_userid ∈ ADMIN_USERIDS
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_USERIDS } from './auth';

export function requireAdmin(req: NextRequest): NextResponse | null {
  const token = req.cookies.get('insforge_access_token')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const uid = req.cookies.get('wecom_userid')?.value;
  if (!uid || !ADMIN_USERIDS.has(uid)) {
    return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
  }
  return null;
}
