// web/lib/__tests__/token-verify.test.ts
// verifyServiceJwt（plan Task 11 / spec §5.6）：JWKS 验签共享件五用例——
// 验签通过返 sub / 过期拒 / scope 缺失拒 / 错误签名拒 / JWKS 不可达 fail-close 且触发错误日志。
// JWKS server 用本地 node:http 起真实端点（非 mock fetch），签名用 jose SignJWT RS256。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SignJWT } from 'jose';

const ISSUER = 'https://sso.shanhaiyiguo.com';
const CLIENT_ID = 'test-client-id';
const KID = 'casdoor-rsa-2026-1';

// 真实签名钥 A（进 JWKS）与干扰钥 B（错误签名用例）
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwks = {
  // 注意：jose 的 exportJWK 对 Node KeyObject 返回 {}（webapi 版只认 CryptoKey），
  // 必须用 node:crypto 原生 export({format:'jwk'})——实测坑，勿改回 exportJWK。
  keys: [{ ...keyA.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }],
};

let server: Server;
let jwksUrl = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('jwks server listen failed');
  jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  vi.resetModules(); // 隔离模块级 JWKS 缓存
  process.env.CASDOOR_JWKS_URL = jwksUrl;
  process.env.CASDOOR_ISSUER = ISSUER;
  process.env.CASDOOR_CLIENT_ID = CLIENT_ID;
});

async function loadModule() {
  return await import('../token-verify');
}

async function signToken(
  opts: {
    key?: KeyObject;
    kid?: string;
    scope?: string;
    sub?: string;
    expiresIn?: number; // 秒；负数=已过期
  } = {}
) {
  const {
    key = keyA.privateKey,
    kid = KID,
    scope = 'openid openclaw:query',
    sub = 'openclaw-gateway',
    expiresIn = 3600,
  } = opts;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope, sub })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(key);
}

type KeyObject = ReturnType<typeof generateKeyPairSync>['privateKey'];

describe('verifyServiceJwt', () => {
  it('验签通过（iss/aud/exp/scope 全命中）→ 返回 { sub }', async () => {
    const { verifyServiceJwt } = await loadModule();
    const token = await signToken();
    const r = await verifyServiceJwt(token, 'openclaw:query');
    expect(r).toEqual({ sub: 'openclaw-gateway' });
  });

  it('过期 token → 拒（null）', async () => {
    const { verifyServiceJwt } = await loadModule();
    const token = await signToken({ expiresIn: -60 });
    expect(await verifyServiceJwt(token, 'openclaw:query')).toBeNull();
  });

  it('scope 缺失（token scope 不含 needScope）→ 拒（null）', async () => {
    const { verifyServiceJwt } = await loadModule();
    const token = await signToken({ scope: 'openid profile' });
    expect(await verifyServiceJwt(token, 'openclaw:query')).toBeNull();
  });

  it('错误签名（kid 命中但由他钥签署）→ 拒（null）', async () => {
    const { verifyServiceJwt } = await loadModule();
    // 先用钥 A 拿一次通过，确认 JWKS 缓存里已有 KID（后续 kid 命中不走刷新）
    const ok = await signToken();
    expect(await verifyServiceJwt(ok, 'openclaw:query')).toEqual({ sub: 'openclaw-gateway' });
    const forged = await signToken({ key: keyB.privateKey }); // header kid=KID 但用 B 签
    expect(await verifyServiceJwt(forged, 'openclaw:query')).toBeNull();
  });

  it('JWKS 不可达 → fail-close 返 null 且触发 [jwks] fetch failed 错误日志', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CASDOOR_JWKS_URL = 'http://127.0.0.1:1/.well-known/jwks'; // 无人监听端口
    const { verifyServiceJwt } = await loadModule();
    const token = await signToken();
    expect(await verifyServiceJwt(token, 'openclaw:query')).toBeNull();
    expect(err).toHaveBeenCalled();
    const first = err.mock.calls[0]?.[0];
    expect(typeof first === 'string' && first.includes('[jwks] fetch failed')).toBe(true);
    err.mockRestore();
  });
});
