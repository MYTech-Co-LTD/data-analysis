// web/app/api/admin/push-presets/__tests__/route.test.ts
// 模板库 CRUD 路由：requireAdmin（admin 闸）→ checkPushPerm(push:configure)（功能闸）→ PostgREST。
// Review 加固（Important-1）：操作者身份来自会话 cookie（wecom_userid），body/query 的 userId 一律忽略。
// mock requireAdmin / checkPushPerm / 全局 fetch（直连 PostgREST），照 permissions/users 路由测试模式。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET, POST, DELETE } from '../route';
import { requireAdmin } from '@/lib/admin-api-auth';
import { checkPushPerm } from '@/app/api/push/route';

vi.mock('@/lib/admin-api-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/app/api/push/route', () => ({ checkPushPerm: vi.fn() }));

const requireAdminMock = vi.mocked(requireAdmin);
const checkPushPermMock = vi.mocked(checkPushPerm);

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ADMIN_COOKIE = 'insforge_access_token=x; wecom_userid=ZhangDuo';

function denyRes(status: number): NextResponse {
  return NextResponse.json({ ok: false, error: 'admin_required' }, { status });
}

function validCard() {
  return {
    card_type: 'news_notice',
    main_title: { title: '📊 数据日报', desc: '销售 ¥1' },
    card_image: { url: 'https://x/banner.png', aspect_ratio: 2.25 },
    card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
  };
}

function mkReq(method: string, url: string, cookie?: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function mkPostReq(cookie?: string, body?: unknown) {
  return mkReq('POST', 'http://localhost/api/admin/push-presets', cookie, body ?? {});
}

function mkDeleteReq(cookie: string | undefined, presetId: string) {
  return mkReq('DELETE', `http://localhost/api/admin/push-presets?preset_id=${presetId}`, cookie);
}

function mkGetReq(cookie?: string) {
  return mkReq('GET', 'http://localhost/api/admin/push-presets', cookie);
}

beforeEach(() => {
  fetchMock.mockReset();
  requireAdminMock.mockReset();
  checkPushPermMock.mockReset();
});

describe('requireAdmin 闸（GET/POST/DELETE 一致）', () => {
  it('未登录（无/坏 cookie）→ 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await POST(mkPostReq());
    expect(res.status).toBe(401);
  });
  it('非 admin（无 data-analysis:admin）→ 403', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(403));
    const res = await DELETE(mkDeleteReq('insforge_access_token=x; wecom_userid=NotAdmin', 'preset-x'));
    expect(res.status).toBe(403);
  });
  it('GET 同样走 requireAdmin（未登录 → 401）', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await GET(mkGetReq());
    expect(res.status).toBe(401);
  });
});

describe('push:configure 功能闸', () => {
  it('admin 但无 push:configure → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await POST(mkPostReq(ADMIN_COOKIE, { name: 't', card_json: validCard() }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('push:configure required');
  });
  it('操作者身份取自已验签 cookie（body.userId 冒充无效）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201 });
    await POST(mkPostReq(ADMIN_COOKIE, { userId: 'Attacker', name: 't', card_json: validCard() }));
    expect(checkPushPermMock).toHaveBeenCalledWith('ZhangDuo', 'push:configure');
  });
});

describe('POST upsert', () => {
  it('合法 card_json → 200 + preset_id', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201 });
    const res = await POST(mkPostReq(ADMIN_COOKIE, { name: '数据日报', card_json: validCard() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preset_id).toBeTruthy();
    // 写入体：msgtype 收敛 template_card、workflow_id 占位、updated_by=cookie uid
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.msgtype).toBe('template_card');
    expect(sent.workflow_id).toBe('scheduled-report');
    expect(sent.updated_by).toBe('ZhangDuo');
  });
  it('msgtype 非 template_card → 400（收敛）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await POST(mkPostReq(ADMIN_COOKIE, { name: 't', msgtype: 'text', card_json: validCard() }));
    expect(res.status).toBe(400);
  });
  it('card_json 校验失败 → 400 + detail', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await POST(mkPostReq(ADMIN_COOKIE, { name: 't', card_json: { card_type: 'text_notice' } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBeTruthy();
  });
});

describe('DELETE 引用保护', () => {
  it('被 push_configs 引用 → 409 拒删', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [{ config_id: 'c1' }] });
    const res = await DELETE(mkDeleteReq(ADMIN_COOKIE, 'preset-x'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('引用');
  });
  it('无引用 → 200 删除成功', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    const res = await DELETE(mkDeleteReq(ADMIN_COOKIE, 'preset-x'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe('GET 列表', () => {
  it('admin → 200 + data', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ preset_id: 'p1', name: '数据日报' }] });
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });
});
