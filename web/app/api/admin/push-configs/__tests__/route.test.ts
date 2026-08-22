// web/app/api/admin/push-configs/__tests__/route.test.ts
// 推送任务 CRUD 路由：requireAdmin（admin 闸）→ checkPushPerm(push:configure)（功能闸）→ PostgREST。
// Review 加固（同 T7）：操作者身份来自会话 cookie（wecom_userid），body/query 的 userId 一律忽略。
// mock requireAdmin / checkPushPerm / 全局 fetch（直连 PostgREST），照 push-presets 路由测试模式。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET, POST, PATCH } from '../route';
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

function validSpec() {
  return {
    name: '每日门店销售日报',
    cron_spec: { kind: 'daily', time: '08:30' },
    selector: { kind: 'dept', ids: ['d1'] },
    target_mode: 'follow',
    preset_id: 'preset-x',
    enabled: true,
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

function mkGetReq(cookie?: string) {
  return mkReq('GET', 'http://localhost/api/admin/push-configs', cookie);
}

function mkPostReq(cookie?: string, body?: unknown) {
  return mkReq('POST', 'http://localhost/api/admin/push-configs', cookie, body ?? {});
}

function mkPatchReq(cookie: string | undefined, configId: string, body?: unknown) {
  return mkReq('PATCH', `http://localhost/api/admin/push-configs?config_id=${configId}`, cookie, body ?? {});
}

beforeEach(() => {
  fetchMock.mockReset();
  requireAdminMock.mockReset();
  checkPushPermMock.mockReset();
});

describe('requireAdmin 闸（GET/POST/PATCH 一致）', () => {
  it('POST 未登录（无/坏 cookie）→ 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await POST(mkPostReq());
    expect(res.status).toBe(401);
  });
  it('GET 未登录 → 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await GET(mkGetReq());
    expect(res.status).toBe(401);
  });
  it('PATCH 未登录 → 401', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(401));
    const res = await PATCH(mkPatchReq(undefined, 'c1', { enabled: false }));
    expect(res.status).toBe(401);
  });
  it('非 admin（无 data-analysis:admin）→ 403', async () => {
    requireAdminMock.mockResolvedValueOnce(denyRes(403));
    const res = await POST(mkPostReq('insforge_access_token=x; wecom_userid=NotAdmin', validSpec()));
    expect(res.status).toBe(403);
  });
});

describe('push:configure 功能闸（GET/POST/PATCH）', () => {
  it('admin 但无 push:configure → 403（POST）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await POST(mkPostReq(ADMIN_COOKIE, validSpec()));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('push:configure required');
  });
  it('GET 无 push:configure → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(403);
  });
  it('PATCH 无 push:configure → 403', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(false);
    const res = await PATCH(mkPatchReq(ADMIN_COOKIE, 'c1', { enabled: false }));
    expect(res.status).toBe(403);
  });
});

describe('POST 校验', () => {
  async function postInvalid(overrides: Record<string, unknown>) {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    return POST(mkPostReq(ADMIN_COOKIE, { ...validSpec(), ...overrides }));
  }

  it('缺 name → 400', async () => {
    const res = await postInvalid({ name: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name required');
  });
  it('cron_spec.kind 非 daily/weekly/monthly → 400', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'hourly', time: '08:30' } });
    expect(res.status).toBe(400);
  });
  it('cron_spec.time 非 HH:mm → 400', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'daily', time: '8:30' } });
    expect(res.status).toBe(400);
  });
  it('cron_spec.time 越界（99:99）→ 400（Fix 2b：旧 \\d{2} 只查位数不查范围）', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'daily', time: '99:99' } });
    expect(res.status).toBe(400);
  });
  it('weekly 缺/错 weekday（非 1-7）→ 400', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'weekly', time: '08:30', weekday: 8 } });
    expect(res.status).toBe(400);
  });
  it('weekly 无 weekday → 400', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'weekly', time: '08:30' } });
    expect(res.status).toBe(400);
  });
  it('monthly 缺/错 day（非 1-31）→ 400', async () => {
    const res = await postInvalid({ cron_spec: { kind: 'monthly', time: '08:30', day: 32 } });
    expect(res.status).toBe(400);
  });
  it('selector.kind 非法（manual）→ 400；role 已开放（U2）→ 通过校验并写入', async () => {
    // role 2026-08-22 启用（U2）：合法 kind，不再 400；走正常写入（fetch 成功 mock）
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => [{ config_id: 'c-role' }] });
    const roleRes = await POST(mkPostReq(ADMIN_COOKIE, { ...validSpec(), selector: { kind: 'role', ids: ['1', '2'] } }));
    expect(roleRes.status).toBe(200);
    const [, roleInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(roleInit.body).selector_json).toEqual({ kind: 'role', ids: ['1', '2'] });
    // 非法 kind 仍拒（manual 不在合法集合）
    const manualRes = await postInvalid({ selector: { kind: 'manual', ids: ['a'] } });
    expect(manualRes.status).toBe(400);
  });
  it('selector.ids 为空 → 400', async () => {
    const res = await postInvalid({ selector: { kind: 'dept', ids: [] } });
    expect(res.status).toBe(400);
  });
  it('target_mode=fixed 缺 target_id → 400', async () => {
    const res = await postInvalid({ target_mode: 'fixed' });
    expect(res.status).toBe(400);
  });
  it('缺 preset_id → 400', async () => {
    const res = await postInvalid({ preset_id: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST 身份（body.userId 冒充无效）', () => {
  it('owner_wecom_id 取 cookie uid，忽略 body.userId=Attacker', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => [{ config_id: 'c-new' }] });
    const res = await POST(mkPostReq(ADMIN_COOKIE, { userId: 'Attacker', ...validSpec() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.config_id).toBe('c-new');
    // 安全不变量：权限判定与写入 owner 都用 cookie 的 wecom_userid
    expect(checkPushPermMock).toHaveBeenCalledWith('ZhangDuo', 'push:configure');
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.owner_wecom_id).toBe('ZhangDuo');
  });
});

describe('POST 写入（合法 spec）', () => {
  it('字段映射：selector→selector_json、target_mode/target_id/preset_id/enabled', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => [{ config_id: 'c-new' }] });
    await POST(mkPostReq(ADMIN_COOKIE, validSpec()));
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.name).toBe('每日门店销售日报');
    expect(sent.cron_spec).toEqual({ kind: 'daily', time: '08:30' });
    expect(sent.selector_json).toEqual({ kind: 'dept', ids: ['d1'] });
    expect(sent.target_mode).toBe('follow');
    expect(sent.target_id).toBeNull();
    expect(sent.preset_id).toBe('preset-x');
    expect(sent.enabled).toBe(true);
    expect(sent.owner_wecom_id).toBe('ZhangDuo');
    expect(sent.updated_at).toBeTruthy();
  });
  it('带 config_id → PATCH 覆盖（upsert）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => [] });
    const res = await POST(mkPostReq(ADMIN_COOKIE, { config_id: 'c1', ...validSpec() }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('config_id=eq.c1');
    expect(init.method).toBe('PATCH');
  });
  it('PostgREST 失败 → 502', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await POST(mkPostReq(ADMIN_COOKIE, validSpec()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('upsert failed');
  });
});

describe('PATCH 启停', () => {
  it('PATCH 只更新 enabled/updated_at（不传 name/cron 等）', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => [] });
    const res = await PATCH(mkPatchReq(ADMIN_COOKIE, 'c1', { enabled: false, name: '改个名', cron_spec: { kind: 'daily' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ enabled: false, updated_at: expect.any(String) });
    expect(sent.name).toBeUndefined();
    expect(sent.cron_spec).toBeUndefined();
  });
  it('缺 config_id → 400', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await mkReq('PATCH', 'http://localhost/api/admin/push-configs', ADMIN_COOKIE, { enabled: false });
    expect((await PATCH(res)).status).toBe(400);
  });
  it('enabled 非 boolean → 400', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    const res = await PATCH(mkPatchReq(ADMIN_COOKIE, 'c1', { enabled: 'yes' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('enabled');
  });
  it('PostgREST 失败 → 502', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await PATCH(mkPatchReq(ADMIN_COOKIE, 'c1', { enabled: false }));
    expect(res.status).toBe(502);
  });
});

describe('GET 列表', () => {
  it('admin + push:configure → 200 + data', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ config_id: 'c1', name: '每日日报', enabled: true }],
    });
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    // 请求含 Task 10 页消费的字段（select=* 覆盖）+ created_at 排序
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('push_configs?select=*&order=created_at.desc');
  });
  it('PostgREST 失败 → 502', async () => {
    requireAdminMock.mockResolvedValueOnce(null);
    checkPushPermMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const res = await GET(mkGetReq(ADMIN_COOKIE));
    expect(res.status).toBe(502);
  });
});
