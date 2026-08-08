// 配销比 = 配送 / 销售。派生值，不落库。
// 实际配销比用实际值；目标配销比用目标值；配销比达成率 = 实际配销比 / 目标配销比。

// 实际配销比 = 配送金额 / 销售金额
export function actualRatio(deliveryActual: number, saleActual: number): number | null {
  if (!saleActual) return null;
  return deliveryActual / saleActual;
}

// 目标配销比 = 配送目标 / 销售目标
export function targetRatio(deliveryTarget: number, saleTarget: number): number | null {
  if (!saleTarget) return null;
  return deliveryTarget / saleTarget;
}

// 配销比达成率 = (deliveryActual/saleActual) / (deliveryTarget/saleTarget)
export function ratioAchievement(
  deliveryActual: number, saleActual: number,
  deliveryTarget: number, saleTarget: number,
): number | null {
  if (!saleTarget || !saleActual) return null;
  if (!deliveryTarget) return null;
  return (deliveryActual / saleActual) / (deliveryTarget / saleTarget);
}

export function formatRatio(r: number | null): string {
  if (r == null) return '—';
  return (r * 100).toFixed(0) + '%';
}

// 毛利率达成率 = 毛利率 / 目标（默认 12% 全局阈值）。
// margin 为 null（成本脱敏）/ 非有限值 / target 为 0 → null。
// 用于毛利率 KPI 卡绝对三色判定。
export function marginAchievement(margin: number | null, target = 0.12): number | null {
  if (margin == null || !Number.isFinite(margin) || !target) return null;
  return margin / target;
}

// 绝对达成率三色（不除时间进度）：>=1 绿 / >=0.8 琥珀 / <0.8 红 / null 灰。
// 用于比率对比固定目标（毛利率 vs 12%、配销比 vs 配销比目标）。
// 区别于现有 KPI 卡/表的相对进度 rateColor(rate, progress)。
export function absoluteThreeColor(rate: number | null): string {
  if (rate == null) return 'text-slate-300';
  return rate >= 1 ? 'text-green-600' : rate >= 0.8 ? 'text-amber-600' : 'text-red-600';
}
