// 生产全链路 UI 测试独立 config（不启本地 webServer，不开 MSW）
// 运行：cd web && npx playwright test --config playwright.config.prod.ts
// token 来源：/tmp/cookies.json（{name,sub,token}[]，服务器 JWT_SECRET 签发，1h 时效）
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/prod',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'https://data.shanhaiyiguo.com',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});