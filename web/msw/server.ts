// web/msw/server.ts
// F7 E2E：MSW node server 组装——在 dev server（Next.js Node 进程）内 patch global fetch，
// 拦截 RSC server 端 DB fetch。由 instrumentation.ts 在 MSW_ENABLED=1 时动态 import 并启动。
//
// 注意：onUnhandledRequest: "bypass" —— 未匹配 handler 的请求（Next.js 内部 fetch、
// 非 report 的 DB 调用等）直接透传真实网络，不拦截、不打日志噪音。

import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

export function startMsw(): void {
  server.listen({ onUnhandledRequest: "bypass" });
  console.log(
    "[msw] F7 E2E: MSW node intercepting RSC server fetch (report_*_gen → 400)",
  );
}
