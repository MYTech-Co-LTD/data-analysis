// web/lib/jobs/env.ts
// Job 共享环境常量（从原 scheduler.ts 顶部搬移，P1 只改组织、不改读取逻辑）。
// 各 job manifest 统一经此处取 env，避免 8 个目录各自复制同一组常量导致口径漂移。
export const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
export const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
export const DUCKDB_URL = process.env.DUCKDB_URL || "http://duckdb:9000";
export const AGENT_API_KEY = process.env.AGENT_API_KEY!; // duckdb-service 鉴权（/compute /carry-dims 校验此 key，非 INSFORGE_API_KEY）
export const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000"; // PostgREST 直连（gateway 不代理 /rpc，固化 RPC 直连）
