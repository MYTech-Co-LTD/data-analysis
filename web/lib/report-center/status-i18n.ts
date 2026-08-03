// data_status 英→中映射（KpiCards 徽章移动端中文化用）。
// 未知 code 兜底"未就绪"（与 kpi-cards 原 statusBadgeClass 的 not_ready 默认一致）。
const MAP: Record<string, string> = {
  complete: "已完成",
  partial: "部分",
  missing: "缺失",
  not_ready: "未就绪",
};

export function statusToZh(code: string): string {
  return MAP[code] ?? "未就绪";
}
