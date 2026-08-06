// web/lib/report-center/freshness.ts
// F5 时效陈旧门：get_data_freshness 返回行 { data_updated_at, last_query_at } 的解析/格式化/陈旧判定。
//   - data_updated_at：3 表最新 /compute 时间的最早（数据新旧，仅展示，不触发横幅）
//   - last_query_at：collect_tasks.last_run_at 心跳（系统活跃；陈旧告警据此——系统停才告警）
// 纯函数，便于单测；组件层（freshness-stale-banner / desktop / mobile）据此渲染红色横幅。

export const FRESHNESS_STALE_HOURS = 6;

// get_data_freshness RPC 返回行（两时间分开展示）
export interface DataFreshness {
  data_updated_at: string | null;
  last_query_at: string | null;
}

// 展示为 Asia/Shanghai "YYYY-MM-DD HH:MM"；解析失败时退化截断；空/无效 → null（调用方显示「—」/「获取失败」）
export function formatFreshnessChina(
  s: string | null | undefined,
): string | null {
  if (!s) return null;
  try {
    return new Date(s)
      .toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .replace(/\//g, "-");
  } catch {
    return s.slice(0, 16).replace("T", " ");
  }
}

// 距今小时数（向下取整）。freshness 空/解析失败 → null（不判陈旧）。
export function staleHoursSince(
  freshness: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!freshness) return null;
  const t = new Date(freshness).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 3_600_000);
}

// 是否陈旧：距今 > FRESHNESS_STALE_HOURS
export function isFreshnessStale(
  freshness: string | null | undefined,
  now?: number,
): boolean {
  const h = staleHoursSince(freshness, now);
  return h != null && h > FRESHNESS_STALE_HOURS;
}

// 陈旧告警文案：基于 last_query_at（系统活跃心跳）判定；null（从未运行）/未陈旧 → null（不渲染横幅）。
// 注意：data_updated_at 数据旧（源头没数据）不算陈旧，仅展示，不走此判定。
export function staleBannerText(
  lastQueryAt: string | null | undefined,
  now?: number,
): string | null {
  const hours = staleHoursSince(lastQueryAt, now);
  if (hours == null || hours <= FRESHNESS_STALE_HOURS) return null;
  const display = formatFreshnessChina(lastQueryAt) ?? lastQueryAt ?? "";
  return `系统最近查询停留在 ${display}，已超 ${hours} 小时未运行`;
}
