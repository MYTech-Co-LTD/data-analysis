// 前端数据层：通过 InsForge PostgREST 读取业务表。
// per-request client：从 cookie 读 access_token（登录态），用 authenticated role 读
// （anon 已被 REVOKE SELECT，未登录拿不到）。
// 对上层保持原有类型与函数签名（snake_case → camelCase 映射在此完成）。
import { cookies } from "next/headers";
import { createClient } from "@insforge/sdk";
import { wrapError } from "./error";

export interface Metric {
  name: string;
  value: string;
  change?: string;
  trend?: "up" | "down" | "flat";
}

export interface Report {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  metrics: Metric[];
}

export interface DataSource {
  id: string;
  name: string;
  description?: string;
  apiEndpoint: string;
  authType: "none" | "api_key" | "oauth" | "basic";
  schedule: string;
  enabled: boolean;
  lastSync?: string;
  rowCount?: number;
}

// PostgREST 原始行（数据库 snake_case）
interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  updated_at: string | null;
  metrics: Metric[] | null;
}
interface SourceRow {
  id: string;
  name: string;
  description: string | null;
  api_endpoint: string;
  auth_type: DataSource["authType"];
  schedule: string;
  enabled: boolean;
  last_sync: string | null;
  row_count: number | null;
}

function formatTime(ts: string | null): string {
  if (!ts) return "";
  return ts.replace("T", " ").substring(0, 16);
}

export async function getClient() {
  const token = (await cookies()).get("insforge_access_token")?.value;
  // 用 access_token（authenticated JWT）当 Bearer：PostgREST 据 JWT 的 role 切到 authenticated。
  // token 缺失则回退 anon（已被 REVOKE SELECT，读不到）。
  // 2026-08-19 性能修复（用户裁定）：server 侧直连 PostgREST（POSTGREST_URL=http://postgrest:3000，
  // web 容器同网络）——InsForge SDK 的 /api/database/records 代理层实测每请求额外 1~5s，
  // 报表页 SSR 累计 12s+。直连后降幅 >90%；浏览器侧无 POSTGREST_URL env，自动回退 SDK 公网路径。
  // 接口兼容：InsForge SDK 的 database 模块本就是 @supabase/postgrest-js 包一层 fetch 重写，
  // 消费方（.from/.rpc）签名不变。
  if (process.env.POSTGREST_URL) {
    const bearer = token || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!;
    const { PostgrestClient } = await import("@supabase/postgrest-js");
    return {
      database: new PostgrestClient(process.env.POSTGREST_URL, {
        headers: { Authorization: `Bearer ${bearer}`, apikey: bearer },
      }),
    };
  }
  return createClient({
    baseUrl: process.env.INSFORGE_API_BASE || process.env.NEXT_PUBLIC_INSFORGE_URL!,
    anonKey: token || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
  });
}

export async function getReports(): Promise<Report[]> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("reports")
      .select("id,name,description,updated_at,metrics");
    if (error) throw error;
    return (data as ReportRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      updatedAt: formatTime(r.updated_at),
      metrics: r.metrics ?? [],
    }));
  } catch (err) {
    console.error("getReports failed:", err);
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}

export async function getReport(id: string): Promise<Report | null> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("reports")
      .select("id,name,description,updated_at,metrics")
      .eq("id", id)
      .single();
    if (error) throw error;
    if (!data) return null;
    const r = data as ReportRow;
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      updatedAt: formatTime(r.updated_at),
      metrics: r.metrics ?? [],
    };
  } catch (err) {
    console.error("getReport failed:", err);
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}

export async function getSources(): Promise<DataSource[]> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("data_sources")
      .select(
        "id,name,description,api_endpoint,auth_type,schedule,enabled,last_sync,row_count"
      );
    if (error) throw error;
    return (data as SourceRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? undefined,
      apiEndpoint: s.api_endpoint,
      authType: s.auth_type,
      schedule: s.schedule,
      enabled: s.enabled,
      lastSync: s.last_sync ? formatTime(s.last_sync) : undefined,
      rowCount: s.row_count ?? undefined,
    }));
  } catch (err) {
    console.error("getSources failed:", err);
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}
