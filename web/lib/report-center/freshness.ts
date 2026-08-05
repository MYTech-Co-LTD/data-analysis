// web/lib/report-center/freshness.ts
// F5 时效陈旧门：get_data_freshness（TIMESTAMPTZ ISO 串）的解析/格式化/陈旧判定。
// 纯函数，便于单测；组件层（freshness-stale-banner / desktop / mobile）据此渲染红色横幅。

export const FRESHNESS_STALE_HOURS = 6;

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
