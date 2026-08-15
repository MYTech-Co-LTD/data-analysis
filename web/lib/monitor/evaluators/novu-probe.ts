import type { Evaluator } from '../types';

// Novu 控制面探活（spec §5.5「探活从 data 侧发起」）：GET NOVU_API_URL 健康端点。
// NOVU_API_URL 为空 = 探活禁用（Novu 未上线/未配置期不告警，与 service_down 固定 URL 表区分）。
// 健康端点按实测（2026-08-15，本机 3.19.0 栈）：GET /v1/health-check 返 200 {"status":"ok"}；
// 根路径 /health 返 404 —— 不存在，故不用 brief 原文的 /health（见 docs/ops/novu-deploy-runbook.md）。
export const NOVU_HEALTH_PATH = '/v1/health-check';

export const evalNovuProbe: Evaluator = async (rule, deps) => {
  const alertKey = 'svc:novu';
  const base = (process.env.NOVU_API_URL ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    return { firing: false, alert_key: alertKey, context: { svc: 'novu', disabled: true } };
  }
  const r = await deps.probe(`${base}${NOVU_HEALTH_PATH}`);
  return {
    firing: !r.ok,
    alert_key: alertKey,
    context: {
      svc: 'novu',
      url: base,
      detail: r.error ?? (r.status ? `status ${r.status}` : 'unreachable'),
      latency_ms: r.latencyMs,
    },
  };
};
