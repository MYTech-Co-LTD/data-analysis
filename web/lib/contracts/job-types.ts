// web/lib/contracts/job-types.ts
// Job 插件契约草案（spec 2026-08-11-modular-plugin-design §4.3；P1 调度拆分时冻结）。
// 仅类型、无实现——P1 起由 web/lib/jobs/* 各模块实现并消费，宿主（薄 scheduler）注入 JobContext。
// DbClient/Row/NotifyInput 为草案占位依赖类型（避免悬空引用），P1 冻结前由 contracts 细化。
export interface JobManifest {
  id: string;                       // 全局唯一，注册表主键
  schedule?: string;                // cron 表达式；缺省 = 手动/事件触发
  dependsOn?: string[];             // 依赖的其它 job id
  run: (ctx: JobContext) => Promise<JobResult>;
}

export interface JobContext {       // 宿主注入，插件禁止自行建 client
  db: DbClient;                     // PostgREST/InsForge client 门面
  duck: (sql: string) => Promise<Row[]>;
  notify: (msg: NotifyInput) => Promise<void>;
  log: (taskId: string, level: string, msg: string) => Promise<void>;
  acquireLock: (key: string, ttlMs: number) => Promise<boolean>;
  now: () => Date;                  // 可注入时钟，便于测试
}

/** Job 执行结果（P1 冻结前可调；status 收口成功/失败/跳过） */
export interface JobResult {
  status: 'ok' | 'error' | 'skipped';
  message?: string;                 // 人类可读摘要（进日志/告警）
  detail?: unknown;                 // 结构化明细（对账计数等）
}

// ---- 草案占位依赖类型（P1 由 contracts 细化，此处仅保证草案可编译） ----
export interface DbClient {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
  from: (table: string) => unknown;
}
export type Row = Record<string, unknown>;
export interface NotifyInput {
  message: string;
  [key: string]: unknown;           // 企微/告警扩展字段，P1 细化
}
