// web/lib/push/__tests__/push-api.test.ts
// push API 越权三连拒 + 限速触发 + schedule owner 校验（plan Task 14 Step 1）：
//   ① 无 push:configure → 403
//   ② 无 push:broadcast + selector.kind=all → 403
//   ③ 手写收件人 selector（非法 kind）→ 400
//   ④ 限速触发（500 人次/h 超限 → 429）
//   ⑤ 单次上限 50（非 broadcast 超 50 → 400）
//   ⑥ schedule owner 校验（不变量 9：configure=false → 403）
//
// 不变量引用：
//   6. selector 只组织维（首期 dept/person，role 随 U2）；extra_filter 门店键约束
//   8. 全员 selector 需 push:broadcast（引擎闸兜底，绕插件同样拒）
//   9. 订阅触发按 owner 实时再校验（RT-1 Critical）
//  selector 只组织维（首期 dept/person，role 随 U2）；手写收件人列表拒。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock 依赖
const verifyServiceJwtMock = vi.fn();
const checkFeaturePermMock = vi.fn();
const runPushMock = vi.fn();

vi.mock('@/lib/token-verify', () => ({
  verifyServiceJwt: (...a: unknown[]) => verifyServiceJwtMock(...a),
}));

vi.mock('@/lib/feature-perm', () => ({
  checkFeaturePerm: (...a: unknown[]) => checkFeaturePermMock(...a),
}));

vi.mock('@/lib/push/admin-service', () => ({
  listPushVariables: vi.fn().mockResolvedValue([]),
  createNovuWorkflow: vi.fn().mockResolvedValue({ id: 'wf-1', name: 'test' }),
  listNovuWorkflows: vi.fn().mockResolvedValue({ data: [], totalCount: 0, page: 1, pageSize: 10 }),
}));

// 需要动态导入 route（vi.mock 必须在 import 前声明）
import { POST, __resetPermCacheForTest, __resetFirstTriggerForTest, __resetRateLimitForTest, setRunPushForTest } from '@/app/api/push/route';

// Helper：构造 POST 请求
function mkPushReq(body: Record<string, unknown>, token = 'valid-service-jwt'): NextRequest {
  return new NextRequest('http://localhost/api/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID_SERVICE_IDENTITY = { sub: 'openclaw-gateway' };
const VALID_SELECTOR = { kind: 'person', ids: ['ZhangDuo'] };
const BROADCAST_SELECTOR = { kind: 'all' };
const DEPT_SELECTOR = { kind: 'dept', ids: ['dept-001'] };

beforeEach(() => {
  vi.clearAllMocks();
  __resetPermCacheForTest();
  __resetFirstTriggerForTest();
  __resetRateLimitForTest();
  setRunPushForTest(runPushMock);

  // 操作者存在性校验（isActiveOperator）查询 org_users —— 默认返回在职用户
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('org_users')) {
      return new Response(JSON.stringify([{ wecom_id: 'ZhangDuo', is_active: true }]), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));

  // 默认：服务 JWT 验签通过
  verifyServiceJwtMock.mockResolvedValue(VALID_SERVICE_IDENTITY);
  // 默认：权限全部通过
  checkFeaturePermMock.mockResolvedValue(true);
  // 默认：run_push 返回成功
  runPushMock.mockResolvedValue({
    txnId: 'test-txn-001',
    groups: 1,
    skipped: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('push API 越权三连拒', () => {
  it('① 无 push:configure 权限 → 403 permission_denied', async () => {
    // configure 权限被拒
    checkFeaturePermMock.mockImplementation((_uid: string, perm: string) => {
      if (perm === 'push:configure') return Promise.resolve(false);
      return Promise.resolve(true);
    });

    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: VALID_SELECTOR,
      userId: 'NoPermUser',
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toContain('push:configure');
    // run_push 不应被调用
    expect(runPushMock).not.toHaveBeenCalled();
  });

  it('② 无 push:broadcast + selector.kind=all → 403 permission_denied', async () => {
    // configure 通过，broadcast 被拒
    checkFeaturePermMock.mockImplementation((_uid: string, perm: string) => {
      if (perm === 'push:broadcast') return Promise.resolve(false);
      return Promise.resolve(true);
    });

    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: BROADCAST_SELECTOR,
      userId: 'NoBroadcastUser',
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toContain('push:broadcast');
    expect(runPushMock).not.toHaveBeenCalled();
  });

  it('③ 手写收件人 selector（非法 kind）→ 400 invalid_selector', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: { kind: 'manual', ids: ['user1', 'user2'] },
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('invalid_selector');
    expect(body.detail).toContain('selector.kind');
    expect(runPushMock).not.toHaveBeenCalled();
  });

  it('③b role kind 已开放（U2）→ 通过校验进入 runPush', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: { kind: 'role', ids: ['1', '2'] },
      userId: 'ZhangDuo',
      // preset 路径不走首触发门（与实际调度任务一致），role selector 原样透传
      presetId: 'scheduled-report-card',
    }));

    // 校验通过（非 400 invalid_selector）；后续结果取决于 runPush mock（默认 ok）
    expect(res.status).not.toBe(400);
    expect(runPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ selector: { kind: 'role', ids: ['1', '2'] } })
    );
  });
});

describe('push API 限速', () => {
  it('④ 限速触发：500 人次/h 超限 → 429 rate_limited', async () => {
    // 模拟已消耗 499 人次（通过多次调用填满窗口）
    // 直接注入：先发 499 人 person selector（每个 ids 1 人，跑 499 次不过限）
    // 简化：直接检查单次超限场景——先跑一个大 ids 刷满
    // 实际实现用内存 Map，测试中直接调多次
    const bigIds = Array.from({ length: 499 }, (_, i) => `user${i}`);

    // 第一次 499 人：通过（≤500）
    const res1 = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: { kind: 'person', ids: bigIds },
      userId: 'RateLimitUser',
    }));
    // 499 > 50 单次上限 → 429（实现中 rate_limited 统一返 429）
    expect(res1.status).toBe(429);

    // 改用多次 50 人请求测试限速
    const ids50 = Array.from({ length: 50 }, (_, i) => `user${i}`);
    for (let i = 0; i < 10; i++) {
      await POST(mkPushReq({
        workflowId: 'wf-rate',
        selector: { kind: 'person', ids: ids50 },
        userId: 'RateLimitUser2',
      }));
    }
    // 10 * 50 = 500 人次，刚好到限
    // 第 11 次应被限
    const res11 = await POST(mkPushReq({
      workflowId: 'wf-rate',
      selector: { kind: 'person', ids: ids50 },
      userId: 'RateLimitUser2',
    }));
    expect(res11.status).toBe(429);
    const body = await res11.json();
    expect(body.error).toBe('rate_limited');
    expect(body.detail).toContain('500');
  });

  it('⑤ 单次上限 50（非 broadcast 超 50 → 429）', async () => {
    const ids51 = Array.from({ length: 51 }, (_, i) => `user${i}`);
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: { kind: 'person', ids: ids51 },
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(body.detail).toContain('50');
  });

  it('⑤b broadcast 豁免单次上限但仍在限速内', async () => {
    // broadcast selector 不受单次上限限制
    // 但需 push:broadcast 权限
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: BROADCAST_SELECTOR,
      userId: 'ZhangDuo',
    }));

    // broadcast 应通过（权限+限速均满足）
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe('push API schedule owner 校验（不变量 9）', () => {
  it('⑥ schedule owner 无 push:configure → 403（撤权收回配置）', async () => {
    // 不变量 9：订阅触发按 owner 实时再校验 push:configure
    // 模拟 owner 权限被撤
    checkFeaturePermMock.mockImplementation((_uid: string, perm: string) => {
      if (perm === 'push:configure') return Promise.resolve(false);
      return Promise.resolve(true);
    });

    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: VALID_SELECTOR,
      userId: 'RevokedUser',
    }));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toContain('push:configure');
  });

  it('⑥b 全员 broadcast owner 撤 configure → 403', async () => {
    // owner 撤了 configure，即使是 broadcast 也应拒
    checkFeaturePermMock.mockImplementation((_uid: string, perm: string) => {
      if (perm === 'push:configure') return Promise.resolve(false);
      return Promise.resolve(true);
    });

    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: BROADCAST_SELECTOR,
      userId: 'RevokedBroadcastUser',
    }));

    expect(res.status).toBe(403);
  });
});

describe('create_workflow 鉴权（B6/M6：操作者 = body.userId，非 selector.ids[0]）', () => {
  it('create_workflow 用 body.userId 鉴权，selector.ids[0] 无权不放行', async () => {
    // body.userId 无 push:configure；即使 selector.ids[0] 是特权用户也应 403
    checkFeaturePermMock.mockImplementation((_uid: string, perm: string) => {
      if (perm === 'push:configure') return Promise.resolve(false);
      return Promise.resolve(true);
    });

    const res = await POST(mkPushReq({
      action: 'create_workflow',
      workflowName: 'wf-x',
      userId: 'NoPermUser',
      selector: { kind: 'person', ids: ['PrivilegedAdmin'] },
    }));

    expect(res.status).toBe(403);
  });

  it('create_workflow 缺 userId → 400', async () => {
    const res = await POST(mkPushReq({
      action: 'create_workflow',
      workflowName: 'wf-x',
    }));
    expect(res.status).toBe(400);
  });

  it('create_workflow 正常 → 200', async () => {
    const res = await POST(mkPushReq({
      action: 'create_workflow',
      workflowName: 'wf-x',
      workflowDescription: 'desc',
      userId: 'ZhangDuo',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.workflow.id).toBe('wf-1');
  });
});

describe('push API 基本校验', () => {
  it('服务 JWT 验签失败 → 401', async () => {
    verifyServiceJwtMock.mockResolvedValue(null);

    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: VALID_SELECTOR,
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('缺少 workflowId → 400', async () => {
    const res = await POST(mkPushReq({
      selector: VALID_SELECTOR,
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('workflowId required');
  });

  it('缺少 selector → 400', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('selector required');
  });

  it('缺少 userId → 400', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: VALID_SELECTOR,
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('userId required (operator identity)');
  });

  it('dept selector 缺 ids → 400', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: { kind: 'dept' },
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_selector');
    expect(body.detail).toContain('non-empty ids');
  });

  it('合法请求 → 200 + run_push 返回', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-1',
      selector: DEPT_SELECTOR,
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.txnId).toBe('test-txn-001');
    expect(body.groups).toBe(1);
  });

  it('selfTest=true：强制 selector=操作者本人（伪造的 body.selector 被覆盖）', async () => {
    // 先正常触发一次解除首触发门（否则首触发门同样强制本人，测不到 selfTest 分支）
    await POST(mkPushReq({
      workflowId: 'wf-selftest',
      selector: VALID_SELECTOR,
      userId: 'ZhangDuo',
    }));
    expect(runPushMock).toHaveBeenCalledTimes(1);
    runPushMock.mockClear();

    // 伪造 selector 指向他人——selfTest 必须服务端覆盖为操作者本人
    const res = await POST(mkPushReq({
      workflowId: 'wf-selftest',
      selector: { kind: 'person', ids: ['SomeoneElse'] },
      userId: 'ZhangDuo',
      selfTest: true,
    }));

    expect(res.status).toBe(200);
    // runPush 收到的 selector 必须是 person:[ZhangDuo]
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({
      selector: { kind: 'person', ids: ['ZhangDuo'] },
    }));
  });

  it('selfTest=true：selector 可省（放宽 selector required，强制发本人）', async () => {
    await POST(mkPushReq({
      workflowId: 'wf-selftest-nosel',
      selector: VALID_SELECTOR,
      userId: 'ZhangDuo',
    }));
    runPushMock.mockClear();

    const res = await POST(mkPushReq({
      workflowId: 'wf-selftest-nosel',
      userId: 'ZhangDuo',
      selfTest: true,
    }));

    expect(res.status).toBe(200);
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({
      selector: { kind: 'person', ids: ['ZhangDuo'] },
    }));
  });

  it('presetId 透传到 runPush', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-preset',
      presetId: 'preset-xyz',
      selector: { kind: 'person', ids: ['ZhangDuo'] },
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(200);
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'preset-xyz' }));
  });

  it('终审 I1：preset 推送不消耗首触发门——selector 保持配置值（非 owner 收件人）', async () => {
    // workflowId 'wf-preset-gate' 从未触发过（不在 firstTriggerSent），但 presetId 显式传入 →
    // 首触发门必须被跳过：selector 不被强制为 owner，收件人就是配置的 selector（SomeOtherUser）
    const res = await POST(mkPushReq({
      workflowId: 'wf-preset-gate',
      presetId: 'preset-xyz',
      selector: { kind: 'person', ids: ['SomeOtherUser'] },
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstTrigger).toBe(false);
    expect(body.note).toBeUndefined();
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({
      selector: { kind: 'person', ids: ['SomeOtherUser'] },
      deliver: true,
    }));
  });

  it('首触发安全门：新 workflow 首次触发只发给自己', async () => {
    const res = await POST(mkPushReq({
      workflowId: 'wf-new',
      selector: DEPT_SELECTOR,
      userId: 'ZhangDuo',
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstTrigger).toBe(true);
    expect(body.note).toContain('self only');

    // 验证 run_push 收到的 selector 是 person=[ZhangDuo]，不是原始 dept selector；
    // M4 修复：首触发 deliver=true（真发给自己），而非 shadow 空跑
    expect(runPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { kind: 'person', ids: ['ZhangDuo'] },
        deliver: true,
      }),
    );

    // 第二次触发应传原始 selector
    runPushMock.mockClear();
    const res2 = await POST(mkPushReq({
      workflowId: 'wf-new',
      selector: DEPT_SELECTOR,
      userId: 'ZhangDuo',
    }));

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.firstTrigger).toBe(false);
    expect(runPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: DEPT_SELECTOR,
        deliver: true,
      }),
    );
  });
});
