// web/lib/sync/casdoor-client.ts
// Casdoor 客户端：provisioning/disable/写角色（Casdoor-first 写入链路）。
// spec §4.5: 写入次序 Casdoor-first（outbox 天然支持）；写穿三径：登录/薄同步/对账回写。
// 所有写操作返回 { ok: boolean; error?: string }，失败不抛异常（由调用方入 outbox）。

const CASDOOR_API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';
const CASDOOR_APP = process.env.CASDOOR_APP || 'shanhai-data';

// ---- token 管理（client_credentials 自动刷新） ----
interface TokenCache {
  token: string;
  expiresAt: number;
}
let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  try {
    const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CASDOOR_CLIENT_ID,
        client_secret: CASDOOR_CLIENT_SECRET,
        scope: 'openid',
      }),
    });
    if (!resp.ok) {
      console.error('[casdoor-client] token fetch failed:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    const expiresIn = (data.expires_in ?? 3600) * 1000;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn - 60_000 };
    return tokenCache.token;
  } catch (e) {
    console.error('[casdoor-client] token fetch error:', (e as Error).message);
    return null;
  }
}

// Task 8 起导出：group-sync（组同步器）复用同一 client_credentials 通道
export async function casdoorFetch(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'no_access_token' };

  try {
    const resp = await fetch(`${CASDOOR_API}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(opts.headers as Record<string, string> ?? {}),
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `casdoor_${resp.status}: ${body}` };
    }
    const data = await resp.json().catch(() => null);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- 用户操作 ----

export interface CasdoorUser {
  name: string;           // wecom_id 作为唯一标识
  displayName: string;    // 中文名
  email?: string;
  phone?: string;
  groups?: string[];      // 部门
}

/**
 * Provisioning：Casdoor JIT 建户（spec: provisioning 先 JIT+人工配角色）
 * 幂等：已存在则跳过
 */
export async function provisionUser(user: CasdoorUser): Promise<{ ok: boolean; error?: string; created?: boolean }> {
  // 先查是否已存在
  const existing = await casdoorFetch(
    `/api/get-user?id=${CASDOOR_ORG}/${encodeURIComponent(user.name)}`,
  );
  if (existing.ok && existing.data) {
    return { ok: true, created: false }; // 已存在，幂等跳过
  }

  const result = await casdoorFetch('/api/add-user', {
    method: 'POST',
    body: JSON.stringify({
      owner: CASDOOR_ORG,
      name: user.name,
      displayName: user.displayName,
      email: user.email ?? '',
      phone: user.phone ?? '',
      groups: user.groups ?? [],
      signupApplication: CASDOOR_APP,
      type: 'normal-user',
    }),
  });

  if (!result.ok) {
    console.error('[casdoor-client] provisionUser failed:', user.name, result.error);
    return { ok: false, error: result.error };
  }
  return { ok: true, created: true };
}

/**
 * 写角色：设置用户的 Casdoor 角色（Casdoor-first）
 * 幂等：先查当前角色，diff 后批量增删
 */
export async function assignRoles(
  wecomId: string,
  roleCodes: string[],
): Promise<{ ok: boolean; error?: string; changed?: boolean }> {
  // 查当前角色
  const current = await casdoorFetch(
    `/api/get-user?id=${CASDOOR_ORG}/${encodeURIComponent(wecomId)}`,
  );
  if (!current.ok || !current.data) {
    return { ok: false, error: 'user_not_found' };
  }

  const user = current.data as Record<string, unknown>;
  const rolesArr = Array.isArray(user.roles) ? user.roles : [];
  const currentRoles: string[] = rolesArr.map((r: unknown) =>
    typeof r === 'object' && r !== null ? String((r as Record<string, unknown>).name ?? '') : String(r),
  );

  // diff
  const toAdd = roleCodes.filter(r => !currentRoles.includes(r));
  const toRemove = currentRoles.filter(r => !roleCodes.includes(r));

  if (toAdd.length === 0 && toRemove.length === 0) {
    return { ok: true, changed: false }; // 无变化，幂等
  }

  // 批量操作
  const errors: string[] = [];

  for (const role of toAdd) {
    const r = await casdoorFetch('/api/add-role-for-user', {
      method: 'POST',
      body: JSON.stringify({
        user: `${CASDOOR_ORG}/${wecomId}`,
        role: `${CASDOOR_ORG}/${role}`,
      }),
    });
    if (!r.ok) errors.push(`add_${role}: ${r.error}`);
  }

  for (const role of toRemove) {
    const r = await casdoorFetch('/api/delete-role-for-user', {
      method: 'POST',
      body: JSON.stringify({
        user: `${CASDOOR_ORG}/${wecomId}`,
        role: `${CASDOOR_ORG}/${role}`,
      }),
    });
    if (!r.ok) errors.push(`remove_${role}: ${r.error}`);
  }

  if (errors.length) {
    console.error('[casdoor-client] assignRoles partial failure:', wecomId, errors);
    return { ok: false, error: errors.join('; ') };
  }

  return { ok: true, changed: true };
}

/**
 * Disable 用户（离职四 sink：即时禁用 Casdoor 登录）
 */
export async function disableUser(wecomId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await casdoorFetch('/api/update-user', {
    method: 'POST',
    body: JSON.stringify({
      owner: CASDOOR_ORG,
      name: wecomId,
      isForbidden: true,
    }),
  });

  if (!result.ok) {
    console.error('[casdoor-client] disableUser failed:', wecomId, result.error);
  }
  return result;
}

/**
 * 拉取用户当前角色（用于 drift diff3 镜像校验）
 */
export async function getUserRoles(wecomId: string): Promise<{
  ok: boolean;
  roles?: string[];
  error?: string;
}> {
  const result = await casdoorFetch(
    `/api/get-user?id=${CASDOOR_ORG}/${encodeURIComponent(wecomId)}`,
  );
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? 'user_not_found' };
  }
  const user = result.data as Record<string, unknown>;
  const rolesArr = Array.isArray(user.roles) ? user.roles : [];
  const roles: string[] = rolesArr.map((r: unknown) =>
    typeof r === 'object' && r !== null ? String((r as Record<string, unknown>).name ?? '') : String(r),
  );
  return { ok: true, roles };
}
