import { createClient } from "@insforge/sdk";

// InsForge 单例 client。前端用 anon_key 经 PostgREST 匿名读取业务表。
// 真实 URL/key 写在 web/.env.local（不入库）。
// server 侧优先内网直连（INSFORGE_API_BASE，2026-08-19 性能修复：消除公网回环 TLS 往返）。
export const insforge = createClient({
  baseUrl: process.env.INSFORGE_API_BASE || process.env.NEXT_PUBLIC_INSFORGE_URL!,
  anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
});
