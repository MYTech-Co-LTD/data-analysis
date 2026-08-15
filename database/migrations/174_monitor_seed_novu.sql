-- 174_monitor_seed_novu.sql
-- Novu 控制面探活规则 seed（Task 5 fix R1）：check_type='novu_health' 一行。
-- evaluator：web/lib/monitor/evaluators/novu-probe.ts —— NOVU_API_URL 为空 = 探活禁用（不告警不发请求），
-- 填入 deploy/.env 后自动生效；随 service_down 桶每分钟节奏（runtime.ts SERVICE_DOWN_BUCKET_TYPES）。
-- 幂等（migrate.sh 每次部署重跑全部迁移）：命中 023 建的唯一索引
--   uniq_monitor_rules_type_target (check_type,target) WHERE target IS NOT NULL → ON CONFLICT DO NOTHING
--   （DO NOTHING 而非 DO UPDATE：上线后运维可能改 template/touser，重跑部署不覆盖人工调整；
--    enabled 不强制回 true，探活开关以 env NOVU_API_URL 为准）。

INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
VALUES ('服务探活·novu', 'novu_health', 'novu', '{}'::jsonb, 'critical',
        '{svc} 不可达({detail})，统一推送将降级 wecom-notify', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO NOTHING;
