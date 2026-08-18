// web/lib/__tests__/offboard-check.test.ts
// 离职四 sink①（188）：checkOffboard 双机制——is_active 软校验 + blacklist 按 sub 拉黑。
// 软校验语义：PostgREST 失败 → 放行（fail-open，可用性优先）；明确 false → 拒。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkOffboard, __resetOffboardCacheForTest } from '../offboard-check';

const REAL_FETCH = global.fetch;

function mockFetch(handlers: Record<string, unknown>) {
  // handlers: url-substring -> response body (or { status, body })
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [frag, resp] of Object.entries(handlers)) {
      if (url.includes(frag)) {
        if (typeof resp === 'object' && resp !== null && 'status' in resp) {
          const r = resp as { status: number; body?: unknown };
          return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
        }
        return new Response(JSON.stringify(resp), { status: 200 });
      }
    }
    return new Response('[]', { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetOffboardCacheForTest();
});

describe('checkOffboard — 离职四 sink①（web API 面即时收权）', () => {
  it('在职用户：is_active=true 且无 blacklist → 放行', async () => {
    mockFetch({
      'org_users': [{ is_active: true }],
      'token_blacklist': [],
    });
    expect(await checkOffboard('tok.jwt.sig', 'ZhangDuo')).toBe(false);
  });

  it('sink-② is_active=false（sync-contacts 对齐即时置 false，不等 thin-sync）→ 拒', async () => {
    mockFetch({
      'org_users': [{ is_active: false }],
      'token_blacklist': [],
    });
    expect(await checkOffboard('tok.jwt.sig', 'LiZhi001')).toBe(true);
  });

  it('sink-① blacklist 按 sub 拉黑（thin-sync disable 写入，is_active 查询失败仍拒）→ 拒', async () => {
    mockFetch({
      'org_users': { status: 500, body: {} },
      'token_blacklist': [{ id: 'bl-1' }], // user_id 维度命中
    });
    expect(await checkOffboard('tok.jwt.sig', 'LiZhi002')).toBe(true);
  });

  it('软校验 fail-open：两查询均故障 → 放行（可用性优先，不全员锁死）', async () => {
    mockFetch({
      'org_users': { status: 500, body: {} },
      'token_blacklist': { status: 500, body: {} },
    });
    expect(await checkOffboard('tok.jwt.sig', 'ZhangDuo')).toBe(false);
  });

  it('用户不存在（org_users 0 行）→ 放行（软校验只拒明确 false；0 行=非本系统路径如服务 JWT）', async () => {
    mockFetch({
      'org_users': [],
      'token_blacklist': [],
    });
    expect(await checkOffboard('tok.jwt.sig', 'UnknownSub')).toBe(false);
  });

  it('缺 sub（旧形状/服务 token）→ 退化为纯 token_hash blacklist 查询', async () => {
    let sawOrFilter = false;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('token_blacklist')) {
        sawOrFilter = url.includes('or=(');
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkOffboard('tok.jwt.sig', undefined)).toBe(false);
    expect(sawOrFilter).toBe(false);
  });

  it('blacklist 查询 URL 按 sub 并集（or=(token_hash,user_id)）', async () => {
    let url = '';
    mockFetch({
      'org_users': [{ is_active: true }],
    });
    // 换一个记录 URL 的 fetch
    const inner = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('token_blacklist')) { url = u; return new Response('[]', { status: 200 }); }
      return inner(input);
    }) as unknown as typeof fetch;
    await checkOffboard('tok.jwt.sig', 'LiZhi003');
    expect(url).toContain('or=(');
    expect(url).toContain(encodeURIComponent('user_id.eq.LiZhi003').replace(/%/g, '%'));
  });

  it('60s TTL 缓存：同 sub 二次调用不再打 org_users（收权最差延迟 60s）', async () => {
    let orgQueries = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('org_users')) { orgQueries++; return new Response(JSON.stringify([{ is_active: true }]), { status: 200 }); }
      if (u.includes('token_blacklist')) return new Response('[]', { status: 200 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await checkOffboard('tok.jwt.sig', 'CacheSub');
    await checkOffboard('tok.jwt.sig', 'CacheSub');
    expect(orgQueries).toBe(1);
  });
});

describe('checkOffboard — blacklist URL 构造安全', () => {
  it('sub 含特殊字符时 encodeURIComponent 防注入', async () => {
    let url = '';
    mockFetch({ 'org_users': [{ is_active: true }] });
    const inner = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('token_blacklist')) { url = u; return new Response('[]', { status: 200 }); }
      return inner(input);
    }) as unknown as typeof fetch;
    await checkOffboard('tok.jwt.sig', 'evil&select=is_admin');
    expect(url).not.toContain('evil&select'); // & 被编码为 %26
  });
});

// 还原全局 fetch，防污染其他测试
import { afterEach } from 'vitest';
afterEach(() => {
  global.fetch = REAL_FETCH;
});
