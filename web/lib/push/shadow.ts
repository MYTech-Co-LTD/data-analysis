// web/lib/push/shadow.ts
// S4 shadow 干跑（plan Task 10）：deliver=false 跑 runPush 全链路渲染，不触发 Novu；
// 渲染产物落 push_trigger_payloads（mode='shadow'），返回 groups 供 diff 脚本比对。
//
// 观察窗用法：
//   1. shadowRun(opts) 每日定时跑（随 push-contract job 或手动），记录新链路渲染快照
//   2. scripts/shadow-diff.mjs 读 shadow 快照 vs 旧通道内容，输出差异报告
//   3. 差异须 = scope 差异解释项（权限不同→值不同属预期），非 scope 差异 = 新链路 bug
//
// 消费 Task 9 runPush（deliver 开关）；mode='shadow' 写入 payload JSONB（Task 9 迁移表无 mode 列）。

import { POSTGREST_URL, INSFORGE_API_KEY } from '../jobs/env';

// ---- 类型（引擎实现后从源模块导入；shadow 仅消费 deliver=false 分支） ----
import type { Selector } from './selectors';

/** 单组渲染产物（引擎 runPush renderedGroups 元素） */
export interface RenderedGroup {
  signature: string;
  members: string[];
  perms: {
    brands?: string[];
    branch_nums?: string[];
    categories?: string[];
    can_see_cost?: boolean;
  };
  rendered: Record<string, string>;
}

/** runPush 返回值（web/lib/push/index.ts）—— shadow 只用到子集 */
interface EngineRunPushResult {
  txnId: string;
  groups: number;
  skipped: string[];
  /** deliver=false 时引擎返回逐组渲染产物（shadow 消费落盘） */
  renderedGroups?: RenderedGroup[];
}

/** runPush 函数签名（web/lib/push/index.ts） */
export type RunPushFn = (opts: {
  workflowId: string;
  selector: Selector;
  operatorId: string;
  broadcastPerm: boolean;
  deliver?: boolean;
}) => Promise<EngineRunPushResult>;

// ---- runPush 集成 ----
// Task 9 实现 runPush 后解除桩；shadow 模式仅消费 deliver=false 分支。
let _runPush: RunPushFn | null = null;

async function getRunPush(): Promise<RunPushFn> {
  if (!_runPush) {
    // 动态 import：push/index.ts 依赖 novu-client / render / fallback，shadow 不应拉起整条链
    // Task 9 实现后此 import 生效；之前调用 shadowRun 会抛出有意义的错误
    try {
      const mod = await import('./index');
      _runPush = mod.runPush;
    } catch {
      throw new Error(
        '[shadow] push/index.ts not found — Task 9 (runPush) must be implemented first. ' +
        'Shadow dry-run depends on runPush with deliver=false support.',
      );
    }
  }
  return _runPush!;
}

// ---- PostgREST 写入 ----

const PG_HEADERS = {
  'Content-Type': 'application/json',
  apikey: INSFORGE_API_KEY!,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
};

/**
 * 写入单组 shadow payload 到 push_trigger_payloads。
 * mode='shadow' 嵌入 payload JSONB（表无 mode 列，Task 9 迁移 173_push_audit.sql 建表）。
 * 返回是否写入成功（review 修复：原实现失败只打日志，调用方无法感知缺组 → diff 静默失真）。
 */
async function insertShadowPayload(
  txnId: string,
  groupSig: string,
  rendered: RenderedGroup,
): Promise<boolean> {
  const body = {
    txn_id: txnId,
    group_sig: groupSig,
    payload: { mode: 'shadow', ...rendered },
  };
  const r = await fetch(`${POSTGREST_URL}/push_trigger_payloads`, {
    method: 'POST',
    headers: PG_HEADERS,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error(`[shadow] insert payload failed: ${r.status} ${detail}`);
    return false;
  }
  return true;
}

// ---- shadow 公共接口 ----

export interface ShadowRunOpts {
  /** Novu workflow id（同 runPush） */
  workflowId: string;
  /** 推送选择器 */
  selector: Selector;
  /** 操作人 wecom_id（审计用） */
  operatorId: string;
  /** 是否广播权限（admin=true 跳过数据权限检查） */
  broadcastPerm?: boolean;
}

export interface ShadowRunResult {
  /** 本次 shadow txn id */
  txnId: string;
  /** 渲染组数 */
  groups: number;
  /** 跳过的用户列表 */
  skipped: string[];
  /** 渲染组详情（含每组 payload，供 diff 脚本消费） */
  rendered: RenderedGroup[];
  /** 落盘失败的组数（>0 = diff 基准不完整，消费方应降级并告警） */
  insertFailed: number;
}

/**
 * Shadow 干跑：跑 runPush 全链路（四守卫→分组→渲染），deliver=false 不触发 Novu。
 * 渲染产物逐组写入 push_trigger_payloads（mode='shadow'），返回 groups 供 diff。
 */
export async function shadowRun(opts: ShadowRunOpts): Promise<ShadowRunResult> {
  const runPush = await getRunPush();

  // deliver=false: 渲染但不投递（Novu trigger 跳过）
  const result = await runPush({
    workflowId: opts.workflowId,
    selector: opts.selector,
    operatorId: opts.operatorId,
    broadcastPerm: opts.broadcastPerm ?? false,
    deliver: false,
  });

  // 渲染产物逐组落盘（mode='shadow' 嵌入 payload JSONB）
  // renderedGroups 由 runPush deliver=false 分支返回
  const rendered: RenderedGroup[] = result.renderedGroups ?? [];

  // 逐组写入（失败不阻断，但计数——diff 消费方据此判定基准完整性）
  let inserted = 0;
  let insertFailed = 0;
  for (const group of rendered) {
    try {
      const ok = await insertShadowPayload(result.txnId, group.signature, group);
      if (ok) inserted++;
      else insertFailed++;
    } catch (e: unknown) {
      console.error(`[shadow] insert failed for group ${group.signature}:`, e);
      insertFailed++;
    }
  }

  console.log(
    `[shadow] txn=${result.txnId} groups=${result.groups} rendered=${rendered.length}` +
    ` inserted=${inserted} failed=${insertFailed} skipped=${result.skipped.length}` +
    (insertFailed > 0 ? ' [INSERT_FAILED: diff 基准不完整]' : ''),
  );

  return {
    txnId: result.txnId,
    groups: result.groups,
    skipped: result.skipped,
    rendered,
    insertFailed,
  };
}

// ---- 直接查询 shadow 快照（供 diff 脚本或调试用） ----

/** 读取指定 txn 的全部 shadow payload（mode='shadow'） */
export async function getShadowPayloads(txnId: string): Promise<RenderedGroup[]> {
  const r = await fetch(
    `${POSTGREST_URL}/push_trigger_payloads?txn_id=eq.${encodeURIComponent(txnId)}&order=group_sig`,
    { headers: PG_HEADERS, cache: 'no-store' },
  );
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`[shadow] read payloads failed: ${r.status} ${detail}`);
  }
  const rows: Array<{ payload: Record<string, unknown> & { mode?: string } }> = await r.json();
  return rows
    .filter((row) => row.payload?.mode === 'shadow')
    .map((row) => {
      const { mode: _mode, ...rest } = row.payload;
      return rest as unknown as RenderedGroup;
    });
}

/** 读取最近 N 条 shadow txn 的 txn_id 列表 */
export async function listShadowTxns(limit = 20): Promise<string[]> {
  // 从 push_trigger_payloads 取去重 txn_id（payload 含 mode='shadow'）
  // 用 @> 包含操作符避免 ->> 在 URL query string 中的编码问题
  const r = await fetch(
    `${POSTGREST_URL}/push_trigger_payloads?select=txn_id&payload=@>{"mode":"shadow"}&order=created_at.desc&limit=${limit}`,
    { headers: PG_HEADERS, cache: 'no-store' },
  );
  if (!r.ok) return [];
  const rows: Array<{ txn_id: string }> = await r.json();
  return [...new Set(rows.map((r) => r.txn_id))];
}
