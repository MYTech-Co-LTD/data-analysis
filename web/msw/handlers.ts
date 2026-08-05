// web/msw/handlers.ts
// F7 E2E：MSW node handlers——拦截 RSC server fetch（dev server Node 进程内）。
//
// 背景：SDK（@insforge/sdk）把 PostgREST 查询映射到
//   {baseUrl}/api/database/records/{table}  （records / 视图读）
//   {baseUrl}/api/database/rpc/{fn}        （RPC，如 get_data_freshness）
// 并经 globalThis.fetch 发出。MSW node（setupServer）patch 全局 fetch，
// 故 dev server 进程内的 RSC server 端 DB fetch 会被这里的 handler 拦截。
// 目的：让 F1 降级 E2E「真正验证」——不依赖 dev 网关对 /api/database/*
// 是 404/401/代理成功 的偶然行为，MSW 确定性地让 report_*_gen 视图读失败。
//
// 仅当 MSW_ENABLED=1（Playwright webServer env）时经 instrumentation 启动；
// 生产构建不设置该 env，且 msw 是 devDependency，不影响生产。

import { http, HttpResponse } from "msw";

// dev 网关 base（与 web/.env.local 的 NEXT_PUBLIC_INSFORGE_URL 对齐）
const DB_BASE_URL =
  process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";

// 转义正则特殊字符，安全构建 RegExp
const escapedBase = DB_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// PostgREST 风格错误体：postgrest-js 对非 ok 响应把 body JSON.parse 成 error 对象
// （PostgrestBuilder.send：res.ok===false → error = JSON.parse(body)），
// 于是 `res.error` 非空 → 页面 totalFailed=true / getter 返 status:'error'。
const PG_ERROR = {
  code: "PGRST116",
  message: "MSW F7 simulated report view query failure",
  details: "msw mocked 400 to force F1 degrade path",
  hint: null,
};

// 所有 report_*_gen 视图读一律失败（total 查询 report_achievement_gen 即 F1 触发点）。
// 400 非 5xx → SDK fetchWithRetry 不重试，测试快且确定。
export const handlers = [
  http.get(
    new RegExp(`^${escapedBase}/api/database/records/report_[^/?]+_gen`),
    () => HttpResponse.json(PG_ERROR, { status: 400 }),
  ),
  // 防御：freshness RPC（get_data_freshness）也失败（仅当 total 成功、getter 阶段才可能触发）
  http.get(new RegExp(`^${escapedBase}/api/database/rpc/`), () =>
    HttpResponse.json(PG_ERROR, { status: 400 }),
  ),
];
