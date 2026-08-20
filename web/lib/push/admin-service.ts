// web/lib/push/admin-service.ts
// Novu 管理面 JWT 代管 + workflow CRUD（plan Task 14 / spec §6.1）：
// Casdoor client_credentials 短时 JWT（60s 前置刷新）→ Novu API 建/列 workflow。
// 插件只持 CASDOOR_CLIENT_ID/SECRET，不持 Novu 凭证；本件代管 Novu admin 操作。
//
// 环境变量：
//   CASDOOR_ORIGIN / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET — Casdoor token
//   NOVU_API_URL / NOVU_API_KEY — Novu 控制面

// ===== Casdoor client_credentials token 管理 =====
// spec §6.1：服务身份 client_credentials 短时 JWT（scope: openclaw:push，60s 前置刷新）

interface CasdoorTokenCache {
  token: string;
  expiresAt: number; // ms timestamp
}

let casdoorTokenCache: CasdoorTokenCache | null = null;
const CASDOOR_TOKEN_REFRESH_MARGIN_MS = 60 * 1000; // 60s 前置刷新

/**
 * 获取 Casdoor client_credentials token（60s 前置刷新）。
 * 失败抛异常（不吞错，调用方需 catch）。
 */
export async function getCasdoorAdminToken(): Promise<string> {
  const now = Date.now();
  if (casdoorTokenCache && now < casdoorTokenCache.expiresAt - CASDOOR_TOKEN_REFRESH_MARGIN_MS) {
    return casdoorTokenCache.token;
  }

  const origin = process.env.CASDOOR_ORIGIN || 'https://sso.shanhaiyiguo.com';
  const clientId = process.env.CASDOOR_CLIENT_ID;
  const clientSecret = process.env.CASDOOR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Casdoor client credentials not configured (CASDOOR_CLIENT_ID/SECRET)');
  }

  const resp = await fetch(`${origin}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'openclaw:push', // Review 修复：verifyServiceJwt 要求 scope 含 openclaw:push
    }),
  });

  if (!resp.ok) {
    throw new Error(`Casdoor token fetch failed: HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new Error('Casdoor token response missing access_token');
  }

  // expires_in 通常 7200s（2h），但 spec 要求 60s 前置刷新
  const ttlMs = ((body.expires_in || 7200) * 1000);
  casdoorTokenCache = {
    token: body.access_token,
    expiresAt: now + ttlMs,
  };

  return body.access_token;
}

/** 测试钩子：清 Casdoor token 缓存。 */
export function __resetCasdoorTokenCacheForTest(): void {
  casdoorTokenCache = null;
}

// ===== Novu API calls =====

const NOVU_API_URL = () => (process.env.NOVU_API_URL || '').replace(/\/+$/, '');
const NOVU_API_KEY = () => process.env.NOVU_API_KEY || '';

function novuHeaders(): Record<string, string> {
  const key = NOVU_API_KEY();
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `ApiKey ${key}` } : {}),
  };
}

export interface NovuWorkflow {
  id: string;
  name: string;
  description?: string;
  triggers: Array<{ identifier: string }>;
  steps: unknown[];
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  steps?: unknown[];
  tags?: string[];
}

/**
 * 创建 Novu workflow。
 * 返回创建后的 workflow（含 id + trigger identifier）。
 */
export async function createNovuWorkflow(input: CreateWorkflowInput): Promise<NovuWorkflow> {
  const base = NOVU_API_URL();
  if (!base) throw new Error('NOVU_API_URL not configured');

  const resp = await fetch(`${base}/v1/workflows`, {
    method: 'POST',
    headers: novuHeaders(),
    body: JSON.stringify({
      name: input.name,
      description: input.description || input.name,
      // ⚠️ 模板变量语法（2026-08-20 生产两连踩）：
      //    1. 渲染上下文是 trigger payload 平铺（getCompilePayload）——{{payload.X}} 恒渲染空串
      //    2. 值可能是 JSON 契约（textcard 等）——必须 triple-stash {{{X}}}，双花括号会 HTML
      //       转义（" → &quot;）致 bridge JSON.parse 失败降级发裸文本
      steps: input.steps || [{ type: 'in_app', content: '{{{content}}}' }],
      tags: input.tags || ['push-admin'],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Novu create workflow failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }

  const body = (await resp.json()) as { data: NovuWorkflow };
  return body.data;
}

/**
 * 列出 Novu workflows（支持 tag 过滤 + 分页）。
 */
export async function listNovuWorkflows(opts?: { tag?: string; page?: number; limit?: number }): Promise<{ data: NovuWorkflow[]; totalCount: number; page: number; pageSize: number }> {
  const base = NOVU_API_URL();
  if (!base) throw new Error('NOVU_API_URL not configured');

  const params = new URLSearchParams();
  if (opts?.tag) params.set('tags', opts.tag);
  if (opts?.page != null) params.set('page', String(opts.page));
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  // 默认只列 push-admin 标签的 workflow
  if (!opts?.tag) params.set('tags', 'push-admin');

  const resp = await fetch(`${base}/v1/workflows?${params}`, {
    method: 'GET',
    headers: novuHeaders(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Novu list workflows failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }

  const body = (await resp.json()) as { data: NovuWorkflow[]; totalCount: number; page: number; pageSize: number };
  return body;
}

/**
 * 获取单个 Novu workflow。
 */
export async function getNovuWorkflow(workflowId: string): Promise<NovuWorkflow> {
  const base = NOVU_API_URL();
  if (!base) throw new Error('NOVU_API_URL not configured');

  const resp = await fetch(`${base}/v1/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'GET',
    headers: novuHeaders(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Novu get workflow failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }

  const body = (await resp.json()) as { data: NovuWorkflow };
  return body.data;
}

// ===== Push variables 查询 =====

const INSFORGE_API_BASE = () => process.env.INSFORGE_API_BASE || 'http://localhost:7130';
const INSFORGE_API_KEY = () => process.env.INSFORGE_API_KEY || '';

/**
 * 从 push_variables 表查可用变量。
 */
export async function listPushVariables(): Promise<Array<{
  var_code: string;
  name: string;
  metric_code: string | null;
  scope_dim: string;
  unit: string | null;
  enabled: boolean;
}>> {
  const base = INSFORGE_API_BASE();
  const key = INSFORGE_API_KEY();

  const resp = await fetch(`${base}/rest/push_variables?select=var_code,name,metric_code,scope_dim,unit,enabled&order=var_code`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`listPushVariables failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }

  return resp.json();
}
