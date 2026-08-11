// web/lib/contracts/collector-types.ts
// Collector 插件契约（spec 2026-08-11-modular-plugin-design §4.3；P2 冻结）。
// 仅类型、无实现——P2 起由 web/lib/collectors/* 各数据源插件实现，
// 宿主（P1 起的薄 scheduler / 采集入口）经 web/lib/collectors/registry.ts 注册表分发。
// 完整性五要素（CLAUDE.md「采集任务数据完整性规则」）作为 CollectResult 强制字段——插件化不削弱完整性。

/** 采集宿主注入的上下文——插件禁止自行建 client / 读取参数之外的秘密。 */
export interface CollectCtx {
  /** 数据源认证令牌（宿主从凭据注入；插件只透传给现有采集函数） */
  authToken: string;
  /** 品牌/公司 id（可选；branches 需 numeric companyId 时插件自行转换） */
  companyId?: string | number;
  /**
   * 数据源内子任务（多端点来源用，如 lemeng：'retail' | 'delivery' | 'wholesale' | 'items' | 'branches'）。
   * 单端点来源（meituan/eleme 未来插件）可忽略。
   */
  task?: string;
  /** 来源特有配置扩展（branchNums/distributionBranch/branchId/branchNumsStr/…） */
  [key: string]: unknown;
}

/** 单次采集选项（宿主透传，不改变现有 full/incremental 语义） */
export interface CollectOptions {
  /** full=覆盖写；incremental=水位线跳过 + /merge 合并（沿用现有采集语义） */
  mode?: 'full' | 'incremental';
  /** 上次成功采集后的总数（水位线），仅 incremental 用 */
  watermarkLastCount?: number;
  /** 数据日期范围（YYYY-MM-DD；明细类来源可带时间，插件自行归一化） */
  dates?: string[];
  /** 来源特有运行参数扩展（pageSize/limit 等） */
  [key: string]: unknown;
}

/**
 * 采集完整性结果——必须携带完整性五要素（CLAUDE.md 铁律）。
 * detail 保留源结果全字段（records/apiTotal/storagePath/newApiTotal/skipped/pageFailures/dedupViolations…），
 * 宿主取水位线/对账明细从 detail 读，不改现有消费方语义。
 */
export interface CollectResult {
  /** ① 拉取完整性：以「累计拉取数 ≥ total」判定（分页失败已计数、不静默丢页） */
  fetchComplete: boolean;
  /** ② 写入失败检测：upsert 批失败条数（parquet 型来源无 upsert 阶段 = 0） */
  upsertFailures: number;
  /** ③ 完整校验：fetchComplete && upsertFailures===0 && 库内 active 数 ≥ 源 total */
  verified: boolean;
  /** ④ 陈旧数据处理（软删除）：本次是否执行「全量先标 is_active=false 再回标 active」 */
  softDeleteApplied: boolean;
  /** ⑤ 失败→告警联动：verified=false 应记 collect_logs failed 并接入 collect_fail 监控告警 */
  alert: boolean;
  /** 人类可读错误摘要（空 = 成功；同 collect_logs.error_message） */
  error?: string;
  /** 源返回的原始结果对象（插件透传，宿主只读） */
  detail?: unknown;
  /** 附加扩展（页级失败计数等，供对账观察） */
  [key: string]: unknown;
}

/**
 * Collector 插件：统一数据源接入（spec §4.3）。
 * 新数据源 = 新目录（collectors/<source>/）+ registry 追加 1 行；插件间禁止互相 import。
 */
export interface Collector {
  /** 数据源标识：'lemeng' | 'meituan' | ...（注册表主键） */
  kind: string;
  /** 单次采集 + 落库，返回完整性五要素 */
  collectOnce(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult>;
  /** C0 对账用：返 API 指定 dates 的总数（无此能力可不实现） */
  count?(ctx: CollectCtx, dates: string[]): Promise<number>;
  /** P2a 金额对账用：返 API 指定 dates 的金额合计（无此能力可不实现） */
  sum?(ctx: CollectCtx, dates: string[]): Promise<number>;
}
