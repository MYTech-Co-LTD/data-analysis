import { test, expect } from '@playwright/test';

// Task 11 (F7): 报表数据守护 E2E 断言——F1 失败降级 + F2 RLS 标注。
//
// Cookie 注入模式（同 mobile-smoke.spec.ts:7-10）：dummy insforge_access_token。
//   - middleware handleRegularBrowser：检 cookie 存在 → checkTokenBlacklist fetch
//     /rest/v1/token_blacklist → 本地 gateway 不代理 /rest/v1/ 返 404 → 返回 false
//     （非黑名单，默认放行）→ 页面继续渲染。
//
// F7（本任务，MSW 真正验证）：之前 F1 依赖 dev 网关对 /api/database/* 的偶然行为
// （404/401）触发降级，且 Playwright page.route 拦不到 RSC server 端 DB fetch。
// 现在用 MSW（node）在 dev server 进程内拦截：
//   - playwright.config.ts webServer 以 MSW_ENABLED=1 起 dev server；
//   - instrumentation.ts 在进程内动态 import ./msw/server 启动 MSW node；
//   - web/msw/handlers.ts 对 {baseUrl}/api/database/records/report_*_gen* 一律返
//     400（PostgREST 错误体）——total 查询（report_achievement_gen）命中 → res.error
//     → totalFailed=true → 降级兜底页（PartialDegradeBanner variant="total-failed"
//     文案「看板数据加载失败」+ PermissionBanner）。
//   - 于是 F1 断言确定性地验证「取数失败 → 降级而非空白/全局 error」，不再依赖网关。
//
// 注意：page.route 只拦浏览器请求；服务端 RSC 查询不经浏览器，故 F1 不再用 route mock。
// F2 的 /api/me 是客户端 PermissionBanner useEffect 内 fetch，page.route 可拦截。
test.describe('报表数据守护 (F1 降级 + F2 RLS 标注)', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
    await context.addCookies([
      { name: 'insforge_access_token', value: 'dummy-test-token', domain: 'localhost', path: '/' },
    ]);
  });

  // F1：取数错误透传 + 降级兜底——MSW 拦截 report_*_gen 视图读返 400，
  // total 查询失败 → variant="total-failed" → 「看板数据加载失败」，
  // 不挂整页（body 可见）、不进全局 error 页。
  test('F1: API 失败时显示模块降级而非空白', async ({ page }) => {
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
