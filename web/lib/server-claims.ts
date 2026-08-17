// web/lib/server-claims.ts
// Server Component 读取当前登录用户 claims（不验签，仅读——UX 软门禁用；
// 真实授权裁决仍由 API 路由内 requireAdmin / PostgREST RLS 做）。
// 看板页（reports/targets/[id]）按 permissions 过滤 BOARDS / KPI 卡片用。
// 无 token / 解码失败 → 返回空 permissions（fail-open 软门禁：显示层保守放行靠 RLS 兜底）。
import { cookies } from 'next/headers';
import { decodeJwtPayload } from './monitor/jwt';

export async function getServerPermissions(): Promise<readonly string[]> {
  try {
    const token = (await cookies()).get('insforge_access_token')?.value;
    if (!token) return [];
    const payload = decodeJwtPayload(token);
    if (!payload) return [];
    if (Array.isArray(payload.permissions)) {
      return payload.permissions.filter((p): p is string => typeof p === 'string');
    }
    return [];
  } catch {
    return [];
  }
}
