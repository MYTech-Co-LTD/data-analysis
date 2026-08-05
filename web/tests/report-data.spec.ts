import { test, expect } from '@playwright/test';

// Task 11 (F7): 报表数据守护 E2E 断言——F1 失败降级 + F2 RLS 标注。
//
// Cookie 注入模式（同 mobile-smoke.spec.ts:7-10）：dummy insforge_access_token。
//   - middleware handleRegularBrowser：检 cookie 存在 → checkTokenBlacklist fetch
//     /rest/v1/token_blacklist → 本地 gateway 不代理 /rest/v1/ 返 404 → 返回 false
//     （非黑名单，默认放行）→ 页面继续渲染。
//   - 页面（async Server Component）服务端 DB 查询同样走 /rest/v1/ → 404 →
//     report_achievement_gen 查询失败 → totalFailed=true → 渲染降级兜底页
//     （PartialDegradeBanner + PermissionBanner），足以断言 F1/F2 UI。
//
// 注意：page.route 只拦浏览器请求；服务端 RSC 查询不经浏览器，故 F1 的 route mock
// 仅为语义文档（若将来查询改走客户端 fetch 可生效）。F2 的 /api/me 是客户端
// PermissionBanner useEffect 内 fetch，page.route 可拦截。
test.describe('报表数据守护 (F1 降级 + F2 RLS 标注)', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    await context.addCookies([
      { name: 'insforge_access_token', value: 'dummy-test-token', domain: 'localhost', path: '/' },
    ]);
  });

  // F1：取数错误透传 + 部分降级——单模块 getter 失败不挂整页。
  // 降级兜底页含 PartialDegradeBanner（total 查询失败 → variant="total-failed"，
  // M9 后文案为「看板数据加载失败」；单模块失败 → "N/7 个模块加载失败"）。
  test('F1: API 失败时显示模块降级而非空白', async ({ page }) => {
    // 保留 route mock 作为 F1 语义文档。服务端查询不经浏览器故不生效；本地 dev
    // 环境 gateway 不代理 /rest/v1/ 致查询自然失败，降级页照常渲染。
    await page.route('**/rest/v1/report_brand_metric_gen**', (r) =>
      r.fulfill({ status: 500, body: '{}' }),
    );

    await page.goto('/reports/targets/823', { waitUntil: 'domcontentloaded' });

    // 降级横幅可见（M9 后 total 失败文案为「看板数据加载失败」；regex /加载失败/ 仍匹配）
    await expect(page.getByText(/加载失败/)).toBeVisible({ timeout: 15000 });

    // 整页仍渲染：body 可见（不空白）
    await expect(page.locator('body')).toBeVisible();

    // 不进全局 error 页（error.tsx 渲染 "报表加载失败" heading——降级不是全局错误）
    await expect(page.getByText('报表加载失败')).toHaveCount(0);
  });

  // F2：RLS/脱敏标注——限门店用户看板显示权限裁剪横幅。
  // PermissionBanner（client component）useEffect 内 fetch('/api/me')，
  // 返 branch_nums 非空非 ['*'] → 显示"按你的门店权限裁剪"提示。
  test('F2: RLS 横幅在限门店用户时显示', async ({ page }) => {
    await page.route('**/api/me', (r) =>
      r.fulfill({ json: { branch_nums: ['001'], can_see_cost: true } }),
    );

    await page.goto('/reports/targets/823', { waitUntil: 'domcontentloaded' });

    // RLS 横幅："ℹ️ 数据已按你的门店权限裁剪——「合计/战区/品牌」行仅含有权门店，非全量"
    await expect(page.getByText(/按你的门店权限裁剪/)).toBeVisible({ timeout: 15000 });
  });
});
