import { test, expect } from '@playwright/test';

test.describe('移动地基', () => {
  test('viewport meta 含 device-width', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const meta = page.locator('meta[name="viewport"]');
    await expect(meta).toHaveAttribute('content', /device-width/);
  });

  test('移动 UA 触发 device_type=mobile cookie', async ({ page }) => {
    await page.context().clearCookies();
    // 注意：middleware matcher 不含 /login（只匹配 /、/reports/*、/mobile*、/admin/*）。
    // 故必须 goto('/')（被 matcher 命中）才会跑 middleware 写 cookie；未登录会 302 跳 /login，
    // 但 cookie 已在 / 响应上设置并保留，断言仍成立。
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const cookies = await page.context().cookies();
    const dt = cookies.find((c) => c.name === 'device_type');
    // Pixel 5 UA → middleware 判定 mobile → 写 device_type=mobile
    expect(dt?.value).toBe('mobile');
  });
});
