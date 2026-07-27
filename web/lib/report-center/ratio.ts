// 配销比 = 配送 / 销售。派生值，不落库。
// 目标配销比用目标值；配销比达成率 = 实际配销比 / 目标配销比。

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
