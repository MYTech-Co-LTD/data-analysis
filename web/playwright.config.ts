import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    // F7 E2E：让 dev server 以 MSW_ENABLED=1 启动，instrumentation.ts 在进程内
    // 启动 MSW node，拦截 RSC server fetch（report_*_gen → 400），F1 降级 E2E 真正验证。
    // reuseExistingServer：CI 强制新起（确定性）；本地若已有手工 dev server（无 MSW）
    // 会复用，此时 F1 依赖网关自然失败——建议本地跑 E2E 前别留手工 dev server。
    reuseExistingServer: !process.env.CI,
    env: {
      MSW_ENABLED: '1',
    },
  },
});
