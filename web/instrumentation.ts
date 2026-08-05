// web/instrumentation.ts
// Next.js instrumentation hook。
//
// 作用：server 启动时自动初始化定时采集调度器，修复「scheduler 仅在首次 /api/admin
// 调用时才初始化、web 容器重启后 cron 静默停止」的可靠性缺陷。
//
// 约束：
// - register() 在 Node.js runtime 启动时执行一次；Edge runtime 直接跳过
//   （node-cron / @insforge/sdk / duckdb 均仅支持 Node）。
// - 不阻塞 server 启动：异步触发，失败带退避重试（重启时后端 DB 可能短暂未就绪）。
// - ensureSchedulerInitialized() 幂等，重试与现有 /api/admin 路由内的调用互不冲突；
//   多次重试均失败时，仍可由首次 /api/admin 请求兜底初始化。

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // F7 E2E：MSW_ENABLED=1（Playwright webServer env）时，在 dev server 进程内
  // 启动 MSW node，拦截 RSC server 端 DB fetch（report_*_gen → 400），
  // 让 F1 降级 E2E 真正验证（不依赖 dev 网关对 /api/database/* 的偶然行为）。
  // 动态 import：生产构建不设 MSW_ENABLED，msw 不会被加载（且是 devDependency）。
  if (process.env.MSW_ENABLED === '1') {
    try {
      const { startMsw } = await import('./msw/server');
      startMsw();
    } catch (err) {
      console.error('[instrumentation] MSW 启动失败（不影响调度器）:', err);
    }
  }

  initSchedulerWithRetry().catch((err) => {
    console.error('[instrumentation] 调度器初始化失败:', err);
  });
}

async function initSchedulerWithRetry() {
  const { ensureSchedulerInitialized } = await import('./lib/scheduler');
  // deploy.sh 中后端先于 web 就绪，通常首次即成功；重启场景下 DB 可能短暂未就绪，
  // 故带退避重试。成功（返回 true）即停；幂等，重试无副作用。
  const delays = [0, 5_000, 15_000];
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (await ensureSchedulerInitialized()) {
      console.log('[instrumentation] 调度器已在 server 启动时初始化');
      return;
    }
  }
  console.error('[instrumentation] 调度器初始化 3 次均失败，等待首次 /api/admin 调用兜底');
}
