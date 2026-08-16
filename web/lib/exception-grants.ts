// web/lib/exception-grants.ts
// 例外 RT 实查（B5/M3）：5min TTL 缓存 + UI 撤销主动失效。查询失败 = fail-close 等同无例外。
//
// 读通道 = 服务端直连 PostgREST（同 web/lib/permission-audit.ts / admin permissions API 模式：
// POSTGREST_URL + INSFORGE_API_KEY，gateway(7130) 不代理表接口，NEXT_PUBLIC_* 直连不可达——
// 对 plan 版 env 的适配）。行级过滤双保险：URL 查询参数（服务端）+ 客户端再滤过期/撤销
// （plan 自带测试断言客户端过滤语义：mock 返回含过期/撤销行时不得计入）。
export interface ExceptionGrants {
  branch_nums: string[]; brands: string[]; categories: string[]; can_see_cost: boolean;
}
const EMPTY: ExceptionGrants = { branch_nums: [], brands: [], categories: [], can_see_cost: false };
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; value: ExceptionGrants }>();

function authHeaders(): Record<string, string> {
  const key = process.env.INSFORGE_API_KEY ?? '';
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export async function getExceptionGrants(sub: string): Promise<ExceptionGrants> {
  const hit = cache.get(sub);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const url = `${process.env.POSTGREST_URL || 'http://postgrest:3000'}/temporary_grants` +
      `?select=dim,value,expires_at,revoked_at&user_id=eq.${encodeURIComponent(sub)}` +
      `&revoked_at=is.null&expires_at=gt.${new Date().toISOString()}` +
      `&order=id`;
    const r = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
    if (!r.ok) throw new Error(`grants ${r.status}`);
    const rows = (await r.json()) as { dim: string; value: string; expires_at: string; revoked_at: string | null }[];
    // 客户端再滤（防御纵深）：服务端过滤漏网（时钟漂移/缓存代理）时仍不放大授权面
    const now = Date.now();
    const active = rows.filter((x) => x.revoked_at == null && new Date(x.expires_at).getTime() > now);
    const value: ExceptionGrants = {
      branch_nums: active.filter((x) => x.dim === 'branch_nums').map((x) => x.value),
      brands: active.filter((x) => x.dim === 'brands').map((x) => x.value),
      categories: active.filter((x) => x.dim === 'categories').map((x) => x.value),
      can_see_cost: active.some((x) => x.dim === 'fields' && x.value === 'cost'),
    };
    cache.set(sub, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(sub, { at: Date.now(), value: EMPTY });   // fail-close 等同无例外（不兜底放行）
    return EMPTY;
  }
}

export function invalidateExceptionCache(sub: string): void { cache.delete(sub); }   // M3 主动失效
export function __resetForTest(): void { cache.clear(); }
