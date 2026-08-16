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
    // branch_nums 缺省 '*' 表示全权（不限门店）
    branch_nums: claims.branch_nums ?? '*',
    // 列掩码（Task 16 消费侧切）：与迁移 182 can_cost_visible() 同款形状鉴别——
    // claims.fields 段存在 → 读 fields.cost（缺 key=false 全掩，新令牌契约）；
    // 缺失 → 回退 legacy 顶层 can_see_cost（旧令牌 B6 双氧，Task 20 sunset 删）。
    // 响应字段名 can_see_cost 保持不变：这是 /api/me → 前端 hook 的内部布尔契约，
    // 语义切换发生在 claims 读取边界（此处），下游 useCanSeeCost/MaskedBadge 不感知。
    can_see_cost: claims.fields
      ? claims.fields.cost === true
      : claims.can_see_cost === true,
  });
}
