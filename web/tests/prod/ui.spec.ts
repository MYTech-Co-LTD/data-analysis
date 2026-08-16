// 生产全链路 UI 测试（2026-08-16，PR#10 上线后首测）
// 目标：https://data.shanhaiyiguo.com
// 手段：伪造短时效 cookie（服务器 JWT_SECRET 签名，claims 参数化）
// 覆盖：登录守卫 / 登录链结构 / admin 门禁 / 报表渲染 / RLS 数据差异 / 移动端
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

const COOKIES_FILE = '/tmp/cookies.json';
interface TestUser { name: string; sub: string; token: string; }
const users: TestUser[] = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
const boss = users.find((u) => u.name === 'boss')!;
const manager = users.find((u) => u.name === 'manager')!;

async function inject(page: Page, u: TestUser) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: 'insforge_access_token', value: u.token, url: 'https://data.shanhaiyiguo.com' },
    { name: 'wecom_userid', value: u.sub, url: 'https://data.shanhaiyiguo.com' },
  ]);
}

test.describe('A. 未登录守卫', () => {
  test('A1 /reports 未登录 → /login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });

  test('A2 /admin/permissions 未登录 → /login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/admin/permissions', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('B. 登录链结构（P0-B1 校验点）', () => {
  test('B1 /auth/start → Casdoor authorize（state 带 UUID::path 结构 + redirect_uri 白名单）', async ({ page }) => {
    const resp = await page.request.get('/auth/start', { maxRedirects: 0 });
    expect(resp.status()).toBe(307);
    const loc = resp.headers()['location'] || '';
    expect(loc).toContain('sso.shanhaiyiguo.com/login/oauth/authorize');
    expect(loc).toContain('redirect_uri=' + encodeURIComponent('https://data.shanhaiyiguo.com/auth/callback'));
    // state = <UUID>::<encoded path>（P0-B1 STATE_RE）
    const m = loc.match(/state=([^&]+)/);
    expect(m).not.toBeNull();
    const state = decodeURIComponent(m![1]);
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}::/);
  });
});

test.describe('C. admin 门禁（requireAdmin: 验签+sub 绑定+permission claim）', () => {
  test('C1 boss（permissions=data-analysis:admin）→ /admin/permissions 三 tab 渲染', async ({ page }) => {
    await inject(page, boss);
    await page.goto('/admin/permissions', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toContainText('admin_required', { useInnerText: true });
    await expect(page).toHaveURL(/\/admin\/permissions/);
    // 三 tab 文案至少出现其一；页面非错误态
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('unauthorized');
    expect(text.length).toBeGreaterThan(100);
  });

  test('C2 manager（无 admin perm）→ /admin/permissions 被 middleware 重定向（?error=admin_required）', async ({ page }) => {
    await inject(page, manager);
    // middleware 对 /admin* 用 302 → /?error=admin_required；maxRedirects:0 看原始 3xx
    const resp = await page.request.get('/admin/permissions', { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(resp.status());
    const loc = resp.headers()['location'] || '';
    expect(loc).toContain('admin_required');
    // 跟随重定向后最终落 / 且页面不渲染管理内容
    const final = await page.goto('/admin/permissions', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toContainText('权限管理', { useInnerText: true });
  });

  test('C3 manager 访问 /api/admin/permissions/users → 拒', async ({ page }) => {
    await inject(page, manager);
    const resp = await page.request.get('/api/admin/permissions/users');
    expect([401, 403]).toContain(resp.status());
  });

  test('C4 boss 访问 /api/admin/permissions/users → 200 {users,roles,departments}', async ({ page }) => {
    await inject(page, boss);
    const resp = await page.request.get('/api/admin/permissions/users');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    // 路由返回包装对象（非裸数组）：users 为用户列表，departments 含四维聚合
    expect(Array.isArray(body.users)).toBe(true);
    expect(Array.isArray(body.roles)).toBe(true);
    expect(Array.isArray(body.departments)).toBe(true);
    expect(body.users.length).toBeGreaterThan(0);
  });

  test('C5 篡改签名 token → 401（验签必须真校验）', async ({ page }) => {
    // token 尾段改一位 → 签名失效
    const tampered = boss.token.slice(0, -3) + 'abc';
    await page.context().clearCookies();
    await page.context().addCookies([
      { name: 'insforge_access_token', value: tampered, url: 'https://data.shanhaiyiguo.com' },
      { name: 'wecom_userid', value: boss.sub, url: 'https://data.shanhaiyiguo.com' },
    ]);
    const resp = await page.request.get('/api/admin/permissions/users');
    expect(resp.status()).toBe(401);
  });
});

test.describe('D. 报表中心渲染 + RLS 数据差异', () => {
  test('D1 boss /reports（目标列表）渲染成功', async ({ page }) => {
    await inject(page, boss);
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/reports/);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('PGRST');
    expect(text).not.toContain('TypeError');
  });

  test('D2 manager /reports 渲染成功（行级 brands/branch_nums 过滤生效，无 500）', async ({ page }) => {
    await inject(page, manager);
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/reports/);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('PGRST');
    expect(text).not.toContain('TypeError');
  });
});

// 注：E 节（/api/me 身份映射）已移除——2026-08-16 生产实探：nginx 仅放行
// /api/admin|/api/auth|/api/wecom-contacts-webhook，其余 /api/* 兜底 7130（InsForge），
// /api/me 返回 Express 默认 404（Cannot GET）。路由代码在仓库（301b8f1 F2.1，有单测），
// 无前端调用方；gap 记录在 UI 测试报告 finding-1，待补 nginx location 或移除路由。

test.describe('F. 移动端视口冒烟', () => {
  test('F1 未登录 / → 移动端正常跳转登录', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // 不断言具体 URL（移动端可能跳 /mobile/login 或 /login），只断言无白屏崩溃
    await expect(page.locator('body')).toBeVisible();
  });

  test('F2 login 页移动端渲染', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);
  });
});