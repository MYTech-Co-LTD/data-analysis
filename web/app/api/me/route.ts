// web/app/api/me/route.ts
// F2.1 — /api/me：解码 cookie JWT 返当前用户权限 claims（branch_nums / can_see_cost）
//
// 用途：前端 RLS 横幅（Task 9）+ 脱敏角标（Task 10）拿到当前用户权限。
// 注意：本路由只读 claim 用于前端**展示标注**，真正鉴权由 PostgREST 层（RLS/GUC）做，
// 所以此处不验签——复用 lib/monitor/jwt 的 decodeJwtPayload（base64url 解码 payload）。
import { NextRequest, NextResponse } from 'next/server';
import { decodeJwtPayload } from '@/lib/monitor/jwt';

export const dynamic = 'force-dynamic'; // 读 cookie，天生动态

export async function GET(req: NextRequest) {
  const token = req.cookies.get('insforge_access_token')?.value;
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // decodeJwtPayload 内部已处理 "Bearer " 前缀 + base64url padding
  const claims = decodeJwtPayload(token);
  if (!claims) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }
  return NextResponse.json({
    // branch_nums（W6 / Task 20 对齐）：顶层镜像已摘——旧令牌（双氧期签发）读顶层，
    // 新令牌读 data_scope.branch_nums（数组含 '*' = 全权；空数组 = 受限∅），两者皆缺省 '*'
    branch_nums: claims.branch_nums ?? claims.data_scope?.branch_nums ?? '*',
    // 列掩码（W6 终态）：唯一源 claims.fields.cost（顶层 can_see_cost 回退已随镜像摘除删——
    // 旧形状令牌在 RLS 终版本就 deny，展示层同向全掩）。响应字段名 can_see_cost 保持不变：
    // 这是 /api/me → 前端 hook 的内部布尔契约，下游 useCanSeeCost/MaskedBadge 不感知。
    can_see_cost: claims.fields?.cost === true,
  });
}
