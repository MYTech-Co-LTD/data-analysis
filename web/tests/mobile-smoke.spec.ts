import { test, expect } from '@playwright/test';

// 移动壳回归：移动 UA → 服务端渲染移动壳（无 Sidebar、Header 简化、无横向溢出）。
// 鉴权：注入 dummy insforge_access_token cookie（middleware 仅检存在性 + blacklist 查询失败默认放行），
// 数据接口 401 → 空数据 → 空态渲染，足以断言壳结构。
test.describe('移动壳回归', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    await context.addCookies([{ name: 'insforge_access_token', value: 'dummy-mobile-test-token', domain: 'localhost', path: '/' }]);
  });

  test('首页移动壳：无 Sidebar + 无横向溢出', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // 移动壳不含 Sidebar（PC 才有）：Sidebar 渲染 <aside>，移动分支应 0 个
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.locator('body')).toBeVisible();
    // body 无横向滚动（关键移动健康指标）
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('Header 移动简化：无 Beta 徽章', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Beta', { exact: true })).toHaveCount(0);
  });
});
