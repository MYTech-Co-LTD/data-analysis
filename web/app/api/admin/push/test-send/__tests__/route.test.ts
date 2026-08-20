// web/app/api/admin/push/test-send/__tests__/route.test.ts
// 测试发送路由：requireAdmin（admin 闸）→ checkPushPerm(push:configure)（功能闸）→ runPush 引擎。
// 安全不变量（spec §4.3，Review 核心）：selector 服务端强制=操作者本人（cookie uid），
//   body 传入的 selector/userId 一律忽略——此用例钉死该行为，未来加收件人覆盖字段会在此失败。
// mock requireAdmin / checkPushPerm / runPush（引擎），照 push-presets 路由测试模式。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { POST } from '../route';
import { requireAdmin } from '@/lib/admin-api-auth';
import { checkPushPerm } from '@/app/api/push/route';
import { runPush } from '@/lib/push';

vi.mock('@/lib/admin-api-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/app/api/push/route', () => ({ checkPushPerm: vi.fn() }));
vi.mock('@/lib/push', () => ({ runPush: vi.fn() }));

const requireAdminMock = vi.mocked(requireAdmin);
const checkPushPermMock = vi.mocked(checkPushPerm);
const runPushMock = vi.mocked(runPush);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

function denyRes(status: number): NextResponse {
  return NextResponse.json({ ok: false, error: 'admin_required' }, { status });
}

function mkPostReq(cookie?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/admin/push/test-send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function okRunPush() {
  return {
    txnId: 'txn-1',
    groups: 1,
    recipients: 1,
    skipped: [],
    mode: 'live' as const,
    fallbackUsed: false,
  };
}

beforeEach(() => {
  requireAdminMock.mockReset();
  checkPushPermMock.mockReset();
  runPushMock.mockReset();
});

describe('requireAdmin 闸', () => {
  it('未登录（无/坏 cookie）→ 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await POST(mkPostReq());
    expect(res.status).toBe(401);
  });
  it('非 admin → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(403));
    const res = await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(res.status).toBe(403);
  });
});

describe('push:configure 功能闸', () => {
  it('admin 但无 push:configure → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('push:configure required');
  });
  it('操作者身份取自已验签 cookie（checkPushPerm 用 cookie uid）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockResolvedValueOnce(okRunPush());
    await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(checkPushPermMock).toHaveBeenCalledWith('ZhangDuo', 'push:configure');
  });
});

describe('请求体校验', () => {
  it('缺 presetId → 400', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await POST(mkPostReq(ADMIN_COOKIE, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('presetId required');
  });
  it('非法 JSON → 400', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await POST(mkPostReq(ADMIN_COOKIE));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid json');
  });
});

describe('服务端强制 self-test 不变量（spec §4.3）', () => {
  it('收件人恒=操作者本人（cookie uid），body 的 selector/userId 一律忽略', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockResolvedValueOnce(okRunPush());
    await POST(
      mkPostReq(ADMIN_COOKIE, {
        presetId: 'p1',
        // 攻击面：body 伪造收件人/身份——必须被忽略
        selector: { kind: 'all', ids: ['everyone'] },
        userId: 'Attacker',
      }),
    );
    expect(runPushMock).toHaveBeenCalledTimes(1);
    const opts = runPushMock.mock.calls[0][0];
    expect(opts.presetId).toBe('p1');
    expect(opts.selector).toEqual({ kind: 'person', ids: ['ZhangDuo'] });
    expect(opts.operatorId).toBe('ZhangDuo');
    expect(opts.broadcastPerm).toBe(false);
    expect(opts.deliver).toBe(true);
  });
  it('selector 恒 person（非广播），不因 body selector=all 提权', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockResolvedValueOnce(okRunPush());
    await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1', selector: { kind: 'all' } }));
    expect(runPushMock.mock.calls[0][0].selector.kind).toBe('person');
  });
});

describe('引擎结果透传', () => {
  it('成功 → 200 + txnId/groups', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockResolvedValueOnce(okRunPush());
    const res = await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.txnId).toBe('txn-1');
    expect(body.groups).toBe(1);
  });
  it('引擎业务错误（r.error，如暂停/无收件人）→ 502 透传', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockResolvedValueOnce({ ...okRunPush(), error: '推送系统已暂停' });
    const res = await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('暂停');
  });
  it('引擎抛错（如 M7 占位符 live 拒投）→ 502', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    runPushMock.mockRejectedValueOnce(new Error('变量 {{sale_amount}} 仍是模板占位符'));
    const res = await POST(mkPostReq(ADMIN_COOKIE, { presetId: 'p1' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('占位符');
  });
});
