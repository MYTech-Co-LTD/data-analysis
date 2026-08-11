// web/lib/qa/types.ts
// 数据质量守护配置类型镜像（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
// 共享类型（CheckType/DetailSource/QaTrigger/ViewAssertion）与语义层 qa-types.ts 字节一致，
// 由 types-shared.ts 提供（config-sync.test.ts 守一致）；CheckResult 为 web 本地执行结果类型
// （generator 构建期不跑检查，不需要）。detail-sources.json / qa-checks.json 的 JSON 结构即契约。
export * from './types-shared';
import type { CheckType, QaTrigger } from './types-shared';

/** 一次检查的执行结果（qa_logs 记录） */
export interface CheckResult {
  run_id: string;
  trigger: QaTrigger;
  check_type: CheckType;
  check_name: string;
  status: 'pass' | 'fail' | 'error' | 'no-data';  // no-data：数据未到（源无数据/parquet 未创建），不与 fail/error 混告警
  diff: number | null;
  detail: unknown[] | null;
}
