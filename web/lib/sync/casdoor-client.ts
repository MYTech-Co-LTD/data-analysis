// web/lib/sync/casdoor-client.ts
// Casdoor 客户端：provisioning/disable/写角色（Casdoor-first 写入链路）。
// spec §4.5: 写入次序 Casdoor-first（outbox 天然支持）；写穿三径：登录/薄同步/对账回写。
// 所有写操作返回 { ok: boolean; error?: string }，失败不抛异常（由调用方入 outbox）。

const CASDOOR_API = process.env.CASDOOR_API_URL || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';
// 2026-08-17（T6 真机）：缺省曾为 'shanhai-data'——Casdoor application 表实际名 'data-analysis'，
// signupApplication 指向不存在 app → add-user HTTP 200 + body{status:'error'} → provision 静默失败。
const CASDOOR_APP = process.env.CASDOOR_APP || 'data-analysis';

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

// 导出供 group-expand 等模块复用同一 fetch seam（契约测试 vi.mock('../casdoor-client')）。
export async function casdoorFetch(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'no_access_token' };

  try {
    // 绝对 URL 直传：group-expand 经此 seam 读 PostgREST（maps_branch_group），非 Casdoor 域
    const url = /^https?:\/\//.test(path) ? path : `${CASDOOR_API}${path}`;
    const resp = await fetch(url, {
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


// ---- 写端点 body 级判红 + get-user 解包（2026-08-17 T6 真机发现）----
// Casdoor 写 API 失败时常见 HTTP 200 + body {status:'error', msg}（PR#20 resource-sync 同款坑，
// casdoor-client 此前只看 HTTP → provision/disable 假成功静默丢动作）。
// get-user 成功响应为 {status:'ok', data:<user>}，data:null = 不存在。

async function casdoorWrite(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const result = await casdoorFetch(path, opts);
  if (!result.ok) return result;
  const body = result.data as { status?: string; msg?: string } | null;
  if (body && typeof body === 'object' && body.status === 'error') {
    return { ok: false, error: `casdoor_body_error: ${body.msg ?? 'unknown'}` };
  }
  return result;
}

async function getUserObj(wecomId: string): Promise<Record<string, unknown> | null | 'fetch_error'> {
  const r = await casdoorFetch(`/api/get-user?id=${CASDOOR_ORG}/${encodeURIComponent(wecomId)}`);
  if (!r.ok) return 'fetch_error';
  const body = r.data as { status?: string; data?: Record<string, unknown> | null } | null;
  if (!body || body.status === 'error' || !body.data) return null; // 不存在
  return body.data;
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
  // 先查是否已存在（get-user 解包：外壳 {status,data}）
  const existing = await getUserObj(user.name);
  if (existing === 'fetch_error') return { ok: false, error: 'get_user_failed' };
  if (existing) {
    return { ok: true, created: false }; // 已存在，幂等跳过
  }

  const result = await casdoorWrite('/api/add-user', {
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

// 部门名 → Casdoor groups 全标识（owner/组名，如 shanhai/运营）。
// 2026-08-17（陈润补挂根因）：thin-sync actionProvision 曾只传 name/displayName 不传 groups，
// 新用户 Casdoor 全空组 → 登录 C2 fail-close 拒绝。组前缀构造收敛到本模块（唯一 CASDOOR_ORG 真相）。
export function casdoorGroupsFromDepts(deptNames: string[]): string[] {
  return [...new Set(deptNames.map((n) => `${CASDOOR_ORG}/${n}`).filter((g) => g.length > CASDOOR_ORG.length + 1))];
}

/**
 * 组对账：确保用户在 Casdoor 的 groups 包含期望组（只补缺失，不删手配组）。
 * 幂等：当前组已含全部期望组 → 不改；否则 update-user 合并写入。
 * 2026-08-17 陈润案例：provision 漏组后此处自愈；薄同步每轮重跑，失败无须入 outbox（下轮自愈）。
 */
export async function syncUserGroups(
  wecomId: string,
  expectedGroups: string[],
): Promise<{ ok: boolean; changed?: boolean; error?: string }> {
  const user = await getUserObj(wecomId);
  if (user === 'fetch_error') return { ok: false, error: 'get_user_failed' };
  if (!user) return { ok: false, error: 'user_not_found_in_casdoor' };

  const current = Array.isArray(user.groups)
    ? (user.groups as unknown[]).map((g) => String(g)).filter(Boolean)
    : [];
  const missing = expectedGroups.filter((g) => !current.includes(g));
  if (missing.length === 0) return { ok: true, changed: false };

  const next = [...current, ...missing]; // 只增不删（保留 Casdoor 侧手配组，防橡皮擦）
  const result = await casdoorWrite(
    `/api/update-user?id=${CASDOOR_ORG}/${encodeURIComponent(wecomId)}`,
    { method: 'POST', body: JSON.stringify({ ...user, groups: next }) },
  );
  if (!result.ok) {
    console.error('[casdoor-client] syncUserGroups failed:', wecomId, result.error);
  }
  return { ok: result.ok, changed: true, error: result.error };
}

/**
 * Disable 用户（离职四 sink：即时禁用 Casdoor 登录）
 */
export async function disableUser(wecomId: string): Promise<{ ok: boolean; error?: string }> {
  // 2026-08-17（T6 真机）：裸 update-user 对 client_credentials token 按 token 身份找用户
  // （'The user: app/data-analysis doesn't exist'，HTTP 200 + body error → 此前假成功，
  // sink③ 从未真正禁用过任何人）。唯可用形态（真机验证）：
  //   get-user?id= 解包 → merge isForbidden → update-user?id=owner/name（?id= 必带）。
  const user = await getUserObj(wecomId);
  if (user === 'fetch_error') return { ok: false, error: 'get_user_failed' };
  if (!user) {
    // 用户本就不存在（provision 曾静默失败）——无法禁用但等价 deny，显式报错入 outbox 观察
    return { ok: false, error: 'user_not_found_in_casdoor' };
  }
  const result = await casdoorWrite(
    `/api/update-user?id=${CASDOOR_ORG}/${encodeURIComponent(wecomId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ ...user, isForbidden: true }),
    },
  );
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

/**
 * 拉取组织全量 role name（契约①替代 H11/W6：Casdoor roles ⊆ 期望源差分的 Casdoor 侧输入；
 * scripts/tests/roles-contract-sunset.test.mjs live 段与发布窗对账 cron 消费）。
 */
export async function casdoorListRoles(): Promise<{
  ok: boolean;
  roles?: string[];
  error?: string;
}> {
  const result = await casdoorFetch(
    `/api/get-roles?owner=${encodeURIComponent(CASDOOR_ORG)}`,
  );
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? 'roles_fetch_failed' };
  }
  const data = result.data as { data?: unknown };
  const rows = Array.isArray(data?.data) ? data.data : [];
  const roles = rows
    .map((r: unknown) => String((r as Record<string, unknown>)?.name ?? ''))
    .filter((n: string) => n.length > 0);
  return { ok: true, roles };
}
