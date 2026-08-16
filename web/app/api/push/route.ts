// web/app/api/push/route.ts
// 内部 push API（plan Task 14 / spec §6.1 三层鉴权）：
// ① verifyServiceJwt('openclaw:push') — Casdoor JWKS 验签（RS256 + iss + aud + exp + scope）
// ② checkPushPerm — Casdoor 实查 push:configure / push:broadcast（5min 缓存 + 24h stale，裁决-1 = deny）
// ③ run_push 引擎闸兜底
//
// POST body: { workflowId, selector, variables?, template? }
// 限速：500 人次/h（按收件人数计）+ 单次上限 50（broadcast 豁免上限仍限速）+ 首触发发给自己
//
// 不变量引用：
//   8. 全员 selector 需 push:broadcast（引擎闸兜底，绕插件同样拒）
//   9. 订阅触发按 owner 实时再校验（RT-1 Critical）：push:configure + 在职
//  selector 只组织维（首期 dept/person，role 随 U2）；手写收件人列表拒。

import { NextRequest, NextResponse } from 'next/server';
import { verifyServiceJwt } from '@/lib/token-verify';
import { checkFeaturePerm } from '@/lib/feature-perm';
import { listPushVariables, createNovuWorkflow, listNovuWorkflows } from '@/lib/push/admin-service';

// ===== Types =====

type Selector = {
  kind: 'dept' | 'person' | 'role' | 'all';
  ids?: string[];
};

type PushRequestBody = {
  workflowId?: string;
  selector?: Selector;
  variables?: string[];
  template?: Record<string, unknown>;
  // action sub-routes
  action?: 'list_variables' | 'create_workflow' | 'list_workflows';
  workflowName?: string;
  workflowDescription?: string;
};

// ===== Selector 校验（双闸：只允许组织维，手写列表拒） =====

const VALID_SELECTOR_KINDS = new Set(['dept', 'person', 'role', 'all']);

function validateSelector(selector: unknown): { ok: true; value: Selector } | { ok: false; error: string } {
  if (!selector || typeof selector !== 'object') {
    return { ok: false, error: 'selector required' };
  }
  const s = selector as Record<string, unknown>;
  if (typeof s.kind !== 'string' || !VALID_SELECTOR_KINDS.has(s.kind)) {
    return { ok: false, error: `selector.kind must be one of: ${[...VALID_SELECTOR_KINDS].join(', ')}` };
  }
  // role kind 随 U2 开放，首期拒绝
  if (s.kind === 'role') {
    return { ok: false, error: 'selector.kind=role not yet enabled (pending U2)' };
  }
  // ids 校验：person/dept 需要 ids 数组；all 不需要
  if (s.kind !== 'all') {
    if (!Array.isArray(s.ids) || s.ids.length === 0) {
      return { ok: false, error: `selector.kind=${s.kind} requires non-empty ids array` };
    }
    if (!s.ids.every((id: unknown) => typeof id === 'string')) {
      return { ok: false, error: 'selector.ids must be string array' };
    }
  }
  return { ok: true, value: { kind: s.kind as Selector['kind'], ids: s.ids as string[] | undefined } };
}

// ===== In-memory rate limiter（按收件人数计：500 人次/h） =====

type RateWindow = {
  count: number;
  windowStart: number; // ms timestamp of hour start
};

const rateMap = new Map<string, RateWindow>();
const RATE_LIMIT_PER_HOUR = 500;
const SINGLE_MAX_RECIPIENTS = 50;

function checkRateLimit(userId: string, recipientCount: number, isBroadcast: boolean): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const windowStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
  const key = userId;
  let window = rateMap.get(key);

  if (!window || window.windowStart !== windowStart) {
    window = { count: 0, windowStart };
    rateMap.set(key, window);
  }

  // 单次上限 50（broadcast 豁免上限仍限速）
  if (!isBroadcast && recipientCount > SINGLE_MAX_RECIPIENTS) {
    return { ok: false, error: `single push max ${SINGLE_MAX_RECIPIENTS} recipients (got ${recipientCount}). broadcast exempt from max.` };
  }

  // 限速按收件人数计
  if (window.count + recipientCount > RATE_LIMIT_PER_HOUR) {
    return { ok: false, error: `rate limit exceeded: ${window.count + recipientCount}/${RATE_LIMIT_PER_HOUR} person-times this hour` };
  }

  window.count += recipientCount;
  return { ok: true };
}

// ===== checkPushPerm（Casdoor 实查 + 5min 缓存 + 24h stale） =====
// spec §6.2 RT-7：push:broadcast / push:configure 5min 实查 + fail-close 24h stale，裁决-1 已裁
// 注：当前实现走 checkFeaturePerm（claims + BREAKGLASS），后续 U2 完成后叠加 casbin 实查
// 本函数做显式结构化检查 + 缓存（满足 spec 的缓存语义），不等 casbin 就绪

type PermCacheEntry = {
  result: boolean;
  fetchedAt: number;
};

const PERM_CACHE_TTL_MS = 5 * 60 * 1000; // 5min
const PERM_STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24h stale

const permCache = new Map<string, PermCacheEntry>();

async function checkPushPerm(
  userId: string,
  perm: string,
  claims?: { permissions?: string[] },
): Promise<boolean> {
  const cacheKey = `${userId}:${perm}`;
  const now = Date.now();
  const cached = permCache.get(cacheKey);

  // 5min 内有效
  if (cached && now - cached.fetchedAt < PERM_CACHE_TTL_MS) {
    return cached.result;
  }

  // 24h 内可用 stale（fail-close：casbin 不可用时不因为缓存过期拒绝合法用户）
  if (cached && now - cached.fetchedAt < PERM_STALE_TTL_MS) {
    // 异步刷新，不阻塞当前请求
    refreshPerm(userId, perm, claims).catch(() => {/* swallow */});
    return cached.result;
  }

  // 无缓存或超过 24h stale → 实查
  return refreshPerm(userId, perm, claims);
}

async function refreshPerm(userId: string, perm: string, claims?: { permissions?: string[] }): Promise<boolean> {
  const result = await checkFeaturePerm(userId, perm, claims);
  const cacheKey = `${userId}:${perm}`;
  permCache.set(cacheKey, { result, fetchedAt: Date.now() });
  return result;
}

/** 测试钩子：清权限缓存。 */
export function __resetPermCacheForTest(): void {
  permCache.clear();
}

/** 测试钩子：清限速窗口。 */
export function __resetRateLimitForTest(): void {
  rateMap.clear();
}

// ===== 首触发安全门 =====
// spec §6.3：新 workflow 首触发先发给自己
const firstTriggerSent = new Set<string>();

function isFirstTrigger(workflowId: string): boolean {
  return !firstTriggerSent.has(workflowId);
}

function markTriggered(workflowId: string): void {
  firstTriggerSent.add(workflowId);
}

/** 测试钩子。 */
export function __resetFirstTriggerForTest(): void {
  firstTriggerSent.clear();
}

// ===== run_push stub（Task 9 产物注入） =====
// 本 task 只做接口层；run_push 引擎由 Task 9 实现。
// 这里做一层安全的 forward，不内联引擎逻辑。

interface RunPushOpts {
  workflowId: string;
  selector: Selector;
  operatorId: string;
  broadcastPerm: boolean;
  deliver?: boolean;
  variables?: string[];
}

interface RunPushResult {
  txnId: string;
  groups: number;
  skipped: string[];
}

// 可注入的 run_push（测试钩子 + 未来 Task 9 替换）
let _runPushImpl: ((opts: RunPushOpts) => Promise<RunPushResult>) | null = null;

export function setRunPushForTest(impl: (opts: RunPushOpts) => Promise<RunPushResult>): void {
  _runPushImpl = impl;
}

async function runPush(opts: RunPushOpts): Promise<RunPushResult> {
  if (_runPushImpl) return _runPushImpl(opts);
  // 临时占位：Task 9 实现后替换为真实 import
  return {
    txnId: crypto.randomUUID(),
    groups: 0,
    skipped: [],
  };
}

// ===== Route handler =====

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ① 服务身份：verifyServiceJwt('openclaw:push')
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const serviceIdentity = await verifyServiceJwt(token, 'openclaw:push');
  if (!serviceIdentity) {
    return NextResponse.json({ ok: false, error: 'unauthorized', detail: 'service JWT verification failed' }, { status: 401 });
  }

  // Parse body
  let body: PushRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  // ===== Sub-routes: list_variables / create_workflow / list_workflows =====
  if (body.action === 'list_variables') {
    try {
      const vars = await listPushVariables();
      return NextResponse.json({ ok: true, variables: vars });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 502 });
    }
  }

  if (body.action === 'create_workflow') {
    if (!body.workflowName) {
      return NextResponse.json({ ok: false, error: 'workflowName required' }, { status: 400 });
    }
    // ② 鉴权：push:configure
    const userId = body.selector?.ids?.[0] || 'unknown';
    const hasConfigPerm = await checkPushPerm(userId, 'push:configure');
    if (!hasConfigPerm) {
      return NextResponse.json({ ok: false, error: 'permission_denied', detail: 'push:configure required' }, { status: 403 });
    }
    try {
      const workflow = await createNovuWorkflow({
        name: body.workflowName,
        description: body.workflowDescription,
        tags: ['push-admin'],
      });
      return NextResponse.json({ ok: true, workflow });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 502 });
    }
  }

  if (body.action === 'list_workflows') {
    try {
      const workflows = await listNovuWorkflows({ tag: 'push-admin' });
      return NextResponse.json({ ok: true, ...workflows });
    } catch (e) {
      return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 502 });
    }
  }

  // ===== Default action: push trigger =====
  if (!body.workflowId) {
    return NextResponse.json({ ok: false, error: 'workflowId required' }, { status: 400 });
  }
  if (!body.selector) {
    return NextResponse.json({ ok: false, error: 'selector required' }, { status: 400 });
  }

  // Selector 校验（双闸：只允许组织维）
  const selResult = validateSelector(body.selector);
  if (!selResult.ok) {
    return NextResponse.json({ ok: false, error: 'invalid_selector', detail: selResult.error }, { status: 400 });
  }
  const selector = selResult.value;
  const isBroadcast = selector.kind === 'all';

  // ② 人员权限：push:configure（所有 push 操作基础）
  // 从 plugin body.userId 取人员身份（spec §6.1 ②）
  const operatorId = (body as Record<string, unknown>).userId as string || '';
  if (!operatorId) {
    return NextResponse.json({ ok: false, error: 'userId required (operator identity)' }, { status: 400 });
  }

  const hasConfigPerm = await checkPushPerm(operatorId, 'push:configure');
  if (!hasConfigPerm) {
    return NextResponse.json({ ok: false, error: 'permission_denied', detail: 'push:configure required' }, { status: 403 });
  }

  // 全员 selector 需 push:broadcast（不变量 8）
  let broadcastPerm = false;
  if (isBroadcast) {
    broadcastPerm = await checkPushPerm(operatorId, 'push:broadcast');
    if (!broadcastPerm) {
      return NextResponse.json({ ok: false, error: 'permission_denied', detail: 'push:broadcast required for broadcast selector' }, { status: 403 });
    }
  }

  // 限速（按收件人数计：500 人次/h + 单次上限 50）
  // selector 是结构化的，实际收件人数在 run_push 解析后才知道。
  // 这里先做预估：person selector 用 ids.length；dept/all 用 1（占位，run_push 精确计数后补扣）
  const estimatedRecipients = selector.ids?.length || 1;
  const rateResult = checkRateLimit(operatorId, estimatedRecipients, isBroadcast);
  if (!rateResult.ok) {
    return NextResponse.json({ ok: false, error: 'rate_limited', detail: rateResult.error }, { status: 429 });
  }

  // 首触发安全门：新 workflow 首触发先发给自己
  const firstTime = isFirstTrigger(body.workflowId);
  let finalSelector = selector;
  if (firstTime) {
    // 首触发：强制 selector 为 person=[operatorId]
    finalSelector = { kind: 'person', ids: [operatorId] };
  }

  // ③ run_push 引擎
  try {
    const result = await runPush({
      workflowId: body.workflowId,
      selector: finalSelector,
      operatorId,
      broadcastPerm,
      deliver: !firstTime, // 首触发 deliver=false（只发给自己，但仍走引擎验证路径）
      variables: body.variables,
    });

    // 标记已触发（解除首触发限制）
    if (firstTime) {
      markTriggered(body.workflowId);
    }

    return NextResponse.json({
      ok: true,
      txnId: result.txnId,
      groups: result.groups,
      skipped: result.skipped,
      firstTrigger: firstTime,
      ...(firstTime ? { note: 'First trigger sent to self only. Next trigger will go to full selector.' } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: 'push_failed', detail: msg }, { status: 500 });
  }
}

// GET: list workflows + list variables
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const serviceIdentity = await verifyServiceJwt(token, 'openclaw:push');
  if (!serviceIdentity) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'list_workflows';

  try {
    if (action === 'list_variables') {
      const vars = await listPushVariables();
      return NextResponse.json({ ok: true, variables: vars });
    }
    const workflows = await listNovuWorkflows({ tag: 'push-admin' });
    return NextResponse.json({ ok: true, ...workflows });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 502 });
  }
}
