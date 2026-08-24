// web/lib/offboard-check.ts
// 离职四 sink①（web API 面即时收权，2026-08-17）：middleware is_active 软校验 +
// token_blacklist 按 sub 拉黑，双机制即时拒（架构 §7.1.2/§6.2 身份表）。
// 此前断链：blacklist 零写入方（表永空）且仅 PC 路径查询、企微路径不查、无 is_active 校验。
// 软校验语义（可用性优先）：查询失败/超时/缺 sub → 放行 + console.error
// （PostgREST 故障不得全员锁死）；明确 is_active=false / blacklisted → 拒。
// is_active 由 sync-contacts 对齐直接置 false（不等 thin-sync），blacklist 由 thin-sync
// disable 动作写入（Casdoor 侧同步禁用）——两层时序独立、互为兜底。
// 60s TTL 内存缓存（by sub）：每请求两次内网 round-trip 降为每分钟一次；收权最差延迟 60s。

const OFFBOARD_CACHE_TTL_MS = 60_000;
const offboardCache = new Map<string, { ok: boolean; active: boolean; blacklisted: boolean; ts: number }>();

async function checkTokenBlacklist(token: string, sub?: string): Promise<boolean> {
  try {
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    // 2026-08-24 修复：InsForge OSS 网关无 /rest/v1 路由（Supabase 云约定），恒 404。
    // 服务端直连内网 PostgREST（与 web/lib/scheduler 同源），鉴权用 POSTGREST_ANON_KEY。
    const baseUrl = process.env.POSTGREST_URL || "http://postgrest:3000";
    const pgrstKey = process.env.POSTGREST_ANON_KEY || "";
    // 离职四 sink①：按 sub 拉黑与按单 token 拉黑并集——thin-sync disable 动作成功后
    // 写入 user_id 维度行，旧 7 天 JWT 全部即刻拒。
    const orFilter = sub
      ? `or=(token_hash.eq.${tokenHash},user_id.eq.${encodeURIComponent(sub)})`
      : `token_hash=eq.${tokenHash}`;
    const response = await fetch(
      `${baseUrl}/rest/v1/token_blacklist?${orFilter}&select=id`,
      {
        headers: {
          "apikey": pgrstKey,
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      }
    );

    if (!response.ok) {
      console.error("Blacklist query failed:", response.status);
      return false;
    }

    const data = await response.json();
    return data.length > 0;
  } catch (e) {
    console.error("Blacklist check failed:", e);
    return false;
  }
}

export async function checkOffboard(token: string, sub: string | undefined): Promise<boolean> {
  if (!sub) return checkTokenBlacklist(token);
  const hit = offboardCache.get(sub);
  if (hit && Date.now() - hit.ts < OFFBOARD_CACHE_TTL_MS) {
    if (!hit.ok) return checkTokenBlacklist(token);
    return !hit.active || hit.blacklisted;
  }
  const baseUrl = process.env.POSTGREST_URL || "http://postgrest:3000";
  const svcKey = process.env.INSFORGE_API_KEY ?? "";
  let active = true;
  let ok = true;
  try {
    const r = await fetch(
      `${baseUrl}/org_users?wecom_id=eq.${encodeURIComponent(sub)}&select=is_active`,
      {
        headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (r.ok) {
      const rows = await r.json();
      active = !(Array.isArray(rows) && rows.length === 1 && rows[0].is_active === false);
    } else {
      ok = false;
      console.error("[offboard] org_users query failed:", r.status);
    }
  } catch (e) {
    ok = false;
    console.error("[offboard] org_users query error:", e);
  }
  const blacklisted = await checkTokenBlacklist(token, sub);
  offboardCache.set(sub, { ok, active, blacklisted, ts: Date.now() });
  if (offboardCache.size > 2000) {
    const now = Date.now();
    for (const k of offboardCache.keys()) {
      const v = offboardCache.get(k)!;
      if (now - v.ts > OFFBOARD_CACHE_TTL_MS) offboardCache.delete(k);
    }
  }
  return !active || blacklisted;
}

// 测试钩子：清缓存
export function __resetOffboardCacheForTest(): void {
  offboardCache.clear();
}
