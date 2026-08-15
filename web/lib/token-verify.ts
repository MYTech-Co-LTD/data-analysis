// web/lib/token-verify.ts
// JWKS 验签共享件（plan Task 11 / spec §5.6）：OpenClaw 统一身份链路的服务 JWT
// 验签一处实现——push API 与 agent-query 共用。RS256 + iss + aud(CASDOOR_CLIENT_ID)
// + exp + scope claim 含 needScope；JWKS 缓存 ≥24h、kid 不命中主动刷新；
// 一切失败（含 JWKS 拉取失败）fail-close 返回 null。
// 注意：本件只验服务身份（sub=application，如 openclaw-gateway），不解析 Casdoor
// roles claim——人员 roles 走 userinfo 兼容层（docs/ops/casdoor-roles-claim-verification.md
// 契约快照，Task 13 U2 callback 实现）。
import { jwtVerify, importJWK } from 'jose';

const DEFAULT_JWKS_URL = 'https://sso.shanhaiyiguo.com/.well-known/jwks';
const DEFAULT_ISSUER = 'https://sso.shanhaiyiguo.com';
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // ≥24h（spec §5.6）
const JWKS_FETCH_TIMEOUT_MS = 5000;

type JwkKey = { kid?: string; kty?: string; [k: string]: unknown };
type JwksCache = { keys: JwkKey[]; fetchedAt: number };

// 模块级缓存（Next.js 单进程内共享；测试经 vi.resetModules 隔离）
let jwksCache: JwksCache | null = null;

/** 测试钩子：清 JWKS 缓存。 */
export function __resetJwksCacheForTest(): void {
  jwksCache = null;
}

function findKey(keys: JwkKey[], kid?: string): JwkKey | undefined {
  if (!kid) return undefined;
  return keys.find((k) => k.kid === kid);
}

async function fetchJwks(url: string): Promise<JwkKey[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!body || !Array.isArray(body.keys)) throw new Error('invalid jwks payload');
  return body.keys as JwkKey[];
}

function decodeHeaderKid(token: string): { kid?: string; alg?: string } | null {
  try {
    const part = token.split('.')[0];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    return JSON.parse(json) as { kid?: string; alg?: string };
  } catch {
    return null;
  }
}

/**
 * 验证 OpenClaw/Casdoor 签发的服务 JWT（client_credentials）。
 * 通过 → { sub }（sub=application 名）；任何不满足（签名/iss/aud/exp/scope/JWKS 不可达）→ null（fail-close）。
 */
export async function verifyServiceJwt(
  token: string,
  needScope: string
): Promise<{ sub: string } | null> {
  try {
    const jwksUrl = process.env.CASDOOR_JWKS_URL || DEFAULT_JWKS_URL;
    const issuer = process.env.CASDOOR_ISSUER || DEFAULT_ISSUER;
    const audience = process.env.CASDOOR_CLIENT_ID;
    if (!audience) {
      // CASDOOR_CLIENT_ID 未配置 = aud 校验无从谈起 → fail-close（不得跳过 aud 校验放行）
      console.error('[jwks] CASDOOR_CLIENT_ID not configured');
      return null;
    }
    if (!token || !needScope) return null;

    const header = decodeHeaderKid(token);
    if (!header || header.alg !== 'RS256') return null; // 只信 RS256

    // 缓存 ≥24h；kid 不命中（轮换后的新钥）→ 主动刷新一次
    const cacheFresh =
      jwksCache !== null && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS;
    if (!cacheFresh || !findKey(jwksCache!.keys, header.kid)) {
      try {
        const keys = await fetchJwks(jwksUrl);
        jwksCache = { keys, fetchedAt: Date.now() };
      } catch (e) {
        // fail-close：JWKS 拉取失败 → 拒绝（不得用陈旧/无钥放行）。
        // 生产告警挂点（spec §5.6「fail-close 触发=page 告警」）：接 monitor/notify
        // 时在此调用告警上报，勿只留本行日志。
        console.error('[jwks] fetch failed', e instanceof Error ? e.message : e);
        return null;
      }
    }
    const jwk = findKey(jwksCache!.keys, header.kid);
    if (!jwk) return null; // 刷新后仍无此 kid → 拒

    const key = await importJWK(jwk as never, 'RS256');
    if (!key) return null;

    // jwtVerify 自带 exp/nbf 校验（过期即抛）
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer,
      audience,
    });

    // scope claim：Casdoor 签发为空格分隔字符串；兼容数组形式
    const scopeRaw = (payload as Record<string, unknown>).scope;
    const scopes = Array.isArray(scopeRaw)
      ? scopeRaw.map(String)
      : typeof scopeRaw === 'string'
        ? scopeRaw.split(/[\s,]+/).filter(Boolean)
        : [];
    if (!scopes.includes(needScope)) return null;

    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null; // 验签异常一律 fail-close
  }
}
