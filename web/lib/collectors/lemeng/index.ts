// web/lib/collectors/lemeng/index.ts
// 乐檬（lemeng）Collector 插件：把现有 web/lib/collect*.ts 的采集函数**适配包装**为统一 Collector 接口。
// ⚠️ 纯接口适配层（spec P2：逻辑不动，只加适配层）：
//   - 不改任何采集业务逻辑，原函数按原签名直接调用；
//   - 只做「入参归位（ctx/opts → 原函数签名）」+「结果映射（原结果 → 完整性五要素）」；
//   - 五要素中源结果未直接暴露的字段（如 items/branches 的 fetchComplete/upsertFailures），
//     用现有公开字段做保守派生（见各映射函数注释），P2 冻结前可调。
import type { Collector, CollectCtx, CollectOptions, CollectResult } from '../../contracts';
import {
  collectOnce as collectRetailOnce,
  countRetailApi,
  sumRetailApi,
  type CollectResult as RetailCollectResult,
} from '../../collect';
import {
  collectDeliveryOnce,
  countDeliveryApi,
  type DeliveryCollectResult,
} from '../../collect-delivery';
import {
  collectWholesaleOnce,
  countWholesaleApi,
  type WholesaleCollectResult,
} from '../../collect-wholesale';
import { collectItems, type CollectItemsResult } from '../../collect-items';
import { collectBranches, type CollectBranchesResult } from '../../collect-branches';

/** lemeng 支持的数据源内子任务（= ctx.task） */
export type LemengTask = 'retail' | 'delivery' | 'wholesale' | 'items' | 'branches';

// ---- ctx/opts 取参辅助（缺参即 fail-fast，避免把脏参数静默透进采集逻辑） ----

function reqString(ctx: CollectCtx, key: string): string {
  const v = ctx[key];
  if (typeof v !== 'string' || v === '') throw new Error(`lemeng: ctx.${key} 缺失（需 string）`);
  return v;
}

function reqNumber(ctx: CollectCtx, key: string): number {
  const v = ctx[key];
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`lemeng: ctx.${key} 缺失（需 number）`);
  return n;
}

function reqNumberArray(ctx: CollectCtx, key: string): number[] {
  const v = ctx[key];
  if (!Array.isArray(v) || v.length === 0) throw new Error(`lemeng: ctx.${key} 缺失（需 number[]）`);
  return v.map(Number);
}

/** 从 ctx/opts 读可选数值（缺省/非数返 undefined） */
function numOpt(source: CollectCtx | CollectOptions, key: string): number | undefined {
  const v = source[key];
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function optDates(opts: CollectOptions): string[] {
  if (opts.dates && opts.dates.length > 0) return opts.dates;
  throw new Error('lemeng: opts.dates 缺失（需 ["YYYY-MM-DD", ...]）');
}

/** 明细类来源的日期归一化：已是 "YYYY-MM-DD HH:MM:SS" 原样透传，否则补起止时刻 */
function toDatetime(date: string, endOfDay: boolean): string {
  return date.includes(' ') ? date : endOfDay ? `${date} 23:59:59` : `${date} 00:00:00`;
}

function datesToRange(dates: string[]): { from: string; to: string } {
  const from = toDatetime(dates[0], false);
  const to = toDatetime(dates[dates.length - 1] ?? dates[0], true);
  return { from, to };
}

// ---- 子任务适配（各自只包一个现有函数，逻辑零改动） ----

/** retail（POS 零售明细 → parquet）：完整五要素映射 */
async function collectRetailTask(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
  const authToken = reqString(ctx, 'authToken');
  const branchNums = reqNumberArray(ctx, 'branchNums');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : branchNums.join(',');
  const pageSize = numOpt(opts, 'pageSize') ?? 200;
  const r: RetailCollectResult = await collectRetailOnce(authToken, branchNums, branchNumsStr, optDates(opts), pageSize, {
    mode: opts.mode,
    watermarkLastCount: opts.watermarkLastCount,
  });
  return mapRetailResult(r);
}

function mapRetailResult(r: RetailCollectResult): CollectResult {
  // 沿用现有「records >= apiTotal」判定（分页失败已计数、不静默丢页）；incremental 水位线跳过视为完整成功
  const fetchComplete = r.skipped || r.records.length >= r.apiTotal;
  const verified = r.skipped || (fetchComplete && !r.error); // 无 upsert 阶段：完整 + 无错误即通过
  return {
    fetchComplete,
    upsertFailures: 0,            // parquet 型：无 upsert 阶段
    verified,
    softDeleteApplied: false,     // retail 明细只写 parquet，无 is_active 软删除
    alert: !verified,             // verified=false → collect_logs failed → collect_fail 告警
    error: r.error || undefined,
    detail: r,                    // 保留 records/apiTotal/newApiTotal/skipped/pageFailures 供宿主水位线/对账
  };
}

async function countRetailTask(ctx: CollectCtx, dates: string[]): Promise<number> {
  const authToken = reqString(ctx, 'authToken');
  const branchNums = reqNumberArray(ctx, 'branchNums');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : branchNums.join(',');
  return countRetailApi(authToken, branchNums, branchNumsStr, dates);
}

async function sumRetailTask(ctx: CollectCtx, dates: string[]): Promise<number> {
  const authToken = reqString(ctx, 'authToken');
  const branchNums = reqNumberArray(ctx, 'branchNums');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : branchNums.join(',');
  const { sum } = await sumRetailApi(authToken, branchNums, branchNumsStr, dates);
  return sum;
}

/** delivery（配送调出明细 → parquet） */
async function collectDeliveryTask(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
  const authToken = reqString(ctx, 'authToken');
  const distributionBranch = reqNumber(ctx, 'distributionBranch');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : String(distributionBranch);
  const { from, to } = datesToRange(optDates(opts));
  const limit = numOpt(opts, 'limit') ?? 200;
  const r: DeliveryCollectResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, from, to, limit, {
    mode: opts.mode,
    watermarkLastCount: opts.watermarkLastCount,
  });
  const fetchComplete = r.skipped || r.records.length >= r.apiTotal;
  const verified = r.skipped || (fetchComplete && !r.error);
  return {
    fetchComplete,
    upsertFailures: 0,
    verified,
    softDeleteApplied: false,
    alert: !verified,
    error: r.error || undefined,
    detail: r, // 含 dedupViolations（去重守卫）
  };
}

async function countDeliveryTask(ctx: CollectCtx, dates: string[]): Promise<number> {
  const authToken = reqString(ctx, 'authToken');
  const distributionBranch = reqNumber(ctx, 'distributionBranch');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : String(distributionBranch);
  const { from, to } = datesToRange(dates);
  return countDeliveryApi(authToken, distributionBranch, branchNumsStr, from, to);
}

/** wholesale（批发销售明细 → parquet） */
async function collectWholesaleTask(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
  const authToken = reqString(ctx, 'authToken');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : '99'; // 签名/header 用，沿用现有默认
  const { from, to } = datesToRange(optDates(opts));
  const limit = numOpt(opts, 'limit') ?? 200;
  const r: WholesaleCollectResult = await collectWholesaleOnce(authToken, branchNumsStr, from, to, limit, {
    mode: opts.mode,
    watermarkLastCount: opts.watermarkLastCount,
  });
  const fetchComplete = r.skipped || r.records.length >= r.apiTotal;
  const verified = r.skipped || (fetchComplete && !r.error);
  return {
    fetchComplete,
    upsertFailures: 0,
    verified,
    softDeleteApplied: false,
    alert: !verified,
    error: r.error || undefined,
    detail: r, // 含 dedupViolations（去重守卫）
  };
}

async function countWholesaleTask(ctx: CollectCtx, dates: string[]): Promise<number> {
  const authToken = reqString(ctx, 'authToken');
  const branchNumsStr = typeof ctx.branchNumsStr === 'string' ? ctx.branchNumsStr : '99';
  const { from, to } = datesToRange(dates);
  return countWholesaleApi(authToken, branchNumsStr, from, to);
}

/** items（商品档案 → dim_item）：源结果未暴露 fetchComplete/upsertFailures，用公开字段保守派生 */
async function collectItemsTask(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
  const authToken = reqString(ctx, 'authToken');
  const branchId = numOpt(ctx, 'branchId') ?? 28444; // 沿用原默认值
  const pageSize = numOpt(opts, 'pageSize') ?? 200;
  const r: CollectItemsResult = await collectItems(authToken, branchId, pageSize);
  // 派生：完整拉取 ≈ 拿到的条数（collected+deduped）≥ API total；verified 为内部合成值（fetchComplete && 无 upsert 失败 && active 达标）
  const fetchComplete = r.verified || r.collected + r.deduped >= r.total;
  const upsertFailures = Math.max(0, r.total - r.collected - r.deduped); // 未成功落库条数（含拉取缺口，见注释）
  return {
    fetchComplete,
    upsertFailures,
    verified: r.verified,
    softDeleteApplied: fetchComplete && r.total > 0, // 软删除前置仅完整拉取时执行（内部 markBrandInactive）
    alert: !r.verified,
    error: r.error || undefined,
    detail: r,
  };
}

/** branches（门店档案 → dim_branch）：同上，源结果未暴露内部标志 */
async function collectBranchesTask(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
  const authToken = reqString(ctx, 'authToken');
  const companyId = Number(ctx.companyId ?? NaN);
  if (!Number.isFinite(companyId)) throw new Error('lemeng: ctx.companyId 缺失（branches 需要品牌 id）');
  const pageSize = numOpt(opts, 'pageSize') ?? 200;
  const r: CollectBranchesResult = await collectBranches(authToken, companyId, pageSize);
  // 派生：verified 为内部合成值；完整拉取 ≈ verified，或「有落库且无错误」（system_id 为空的特殊店不入库，collected 可 < total）
  const fetchComplete = r.verified || (r.collected > 0 && !r.error);
  const upsertFailures = Math.max(0, r.total - r.collected);
  return {
    fetchComplete,
    upsertFailures,
    verified: r.verified,
    softDeleteApplied: fetchComplete && r.total > 0, // 软删除前置仅完整拉取时执行（内部 markBrandInactive）
    alert: !r.verified,
    error: r.error || undefined,
    detail: r,
  };
}

// ---- 乐檬 Collector 插件本体：按 ctx.task 分发到上述子任务适配 ----

export const lemengCollector: Collector = {
  kind: 'lemeng',

  async collectOnce(ctx: CollectCtx, opts: CollectOptions): Promise<CollectResult> {
    switch (ctx.task) {
      case 'retail': return collectRetailTask(ctx, opts);
      case 'delivery': return collectDeliveryTask(ctx, opts);
      case 'wholesale': return collectWholesaleTask(ctx, opts);
      case 'items': return collectItemsTask(ctx, opts);
      case 'branches': return collectBranchesTask(ctx, opts);
      default:
        return {
          fetchComplete: false,
          upsertFailures: 0,
          verified: false,
          softDeleteApplied: false,
          alert: true,
          error: `lemeng collectOnce: 未知 task '${String(ctx.task)}'（期望 retail|delivery|wholesale|items|branches）`,
        };
    }
  },

  async count(ctx: CollectCtx, dates: string[]): Promise<number> {
    switch (ctx.task) {
      case 'retail': return countRetailTask(ctx, dates);
      case 'delivery': return countDeliveryTask(ctx, dates);
      case 'wholesale': return countWholesaleTask(ctx, dates);
      default:
        throw new Error(`lemeng count: 不支持 task '${String(ctx.task)}'（支持 retail|delivery|wholesale；items/branches 无 C0 count）`);
    }
  },

  async sum(ctx: CollectCtx, dates: string[]): Promise<number> {
    if (ctx.task !== 'retail') {
      throw new Error(`lemeng sum: 仅 retail 支持（当前 task='${String(ctx.task)}'）`);
    }
    return sumRetailTask(ctx, dates);
  },
};
