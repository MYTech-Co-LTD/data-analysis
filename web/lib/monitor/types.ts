// 监控告警体系共享类型（架构 §8.1）

// v1 支持的检查类型；Phase B 会扩展后三类
export type CheckType =
  | 'service_down'
  | 'token_expire'
  | 'collect_fail'
  | 'collect_stall'
  | 'request_fail'
  | 'data_freshness'
  | 'data_integrity'
  | 'contact_sync';

export type Severity = 'critical' | 'high' | 'medium';

// monitor_rules 行
export interface MonitorRule {
  id: number;
  name: string;
  check_type: CheckType;
  target: string | null;
  threshold: Record<string, any>;
  severity: Severity;
  touser: string | null;
  template: string | null;
  suppress_window_seconds: number;
  enabled: boolean;
}

// evaluator 产出
export interface EvalResult {
  firing: boolean;
  alert_key: string;
  context: Record<string, any>; // 供模板渲染
  // 可选：异常路径（如 token 缺失/不可解析）提供完整文案，覆盖 rule.template 渲染，
  // 避免 {remain_hours} 这类占位符在异常下渲染成 undefined。
  message?: string;
}

// evaluator 依赖注入（engine 提供真实实现，测试提供 fake）
export interface EvalDeps {
  now: Date;
  probe: (url: string, opts?: { timeoutMs?: number; method?: string }) => Promise<ProbeOutcome>;
  getCredentialToken: (sourceId: string) => Promise<string | null>;
  // collect_fail 用：取某采集任务最近 limit 条 collect_logs（最新在前）
  getCollectLogs: (taskId: string, limit: number) => Promise<Array<{ status: string; started_at: string; error_message: string | null }>>;
  // collect_stall 用：取全部采集任务（last_run_at 心跳陈旧检测）
  getCollectTasks: () => Promise<Array<{ id: string; name: string; schedule_cron: string; enabled: boolean; last_run_at: string | null }>>;
}

export interface ProbeOutcome {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

// evaluator 签名
export type Evaluator = (rule: MonitorRule, deps: EvalDeps) => Promise<EvalResult>;
