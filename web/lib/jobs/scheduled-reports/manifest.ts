// web/lib/jobs/scheduled-reports/manifest.ts
// 定时报表推送（U7 cutover）：替代旧 wecom-push cron，路由经 run_push 引擎。
// 旧路径：wecom-push function → 读 reports 表 → 企微 textcard 直投（已退役，代码保留）。
// 新路径：读 scheduled_reports → run_push 引擎（四守卫+Novu+bridge+降级）→ txnId 日志。
// txnId 贯穿 trigger log → Novu → bridge，全链路可追。
// rollback：重启用 wecom-push cron 即可回退旧路径（代码未删）。
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { AGENT_API_KEY } from '../env';
import { runningTasks } from '../state';
import { matchesDate, isTimeReached, type CronSpec } from './cron-match';
import { checkTargetActive, notifyOwnerOnce, listActiveTargets } from '../../push/target-guard';

// run_push 接口契约（Task 9 产出，按 spec §5.4 签名）
interface RunPushOpts {
  workflow_id: string;
  operator_id: string;
  // T6：selector 兼容两代格式——新 push_configs.selector_json {kind, ids}（type 可选）；
  // normalizeSelector 对 kind/type 双格式归一
  selector: { type?: string; kind?: string; ids?: string[]; [key: string]: unknown };
  broadcast_perm?: boolean;
  deliver?: boolean;
  template_key?: string | null;
  query_intent?: unknown | null;
  cron_job_id?: string | null;
  /** 自助配置平台（T6）：preset 显式传 + 目标取值模式（透传 /api/push presetId/targetMode/targetId） */
  preset_id?: string;
  target_mode?: string;
  target_id?: number;
}

interface RunPushResult {
  txnId: string;
  groups: number;
  skipped: string[];
  fallback?: boolean;
  fallbackReason?: string;
}

/**
 * 调 web /api/push 路由到 run_push 引擎。
 * 与 agent-query push_report 模式同路径，保证投递口径一致。
 * Review 修复（B3）：body 字段对齐 route 契约（camelCase workflowId/userId/selector.kind），
 * 鉴权用 AGENT_API_KEY（route 已支持内部调用方双通道）。
 */
function normalizeSelector(raw: unknown): { kind: string; ids?: string[] } {
  if (!raw || typeof raw !== 'object') return { kind: 'all' };
  const r = raw as Record<string, unknown>;
  if (typeof r.kind === 'string') return { kind: r.kind, ids: Array.isArray(r.ids) ? (r.ids as string[]) : undefined };
  // 旧格式 {type: 'all'} → {kind: 'all'}
  const t = r.type;
  if (t === 'all') return { kind: 'all' };
  if (typeof t === 'string') return { kind: t, ids: Array.isArray(r.ids) ? (r.ids as string[]) : undefined };
  return { kind: 'all' };
}

async function callRunPush(opts: RunPushOpts): Promise<RunPushResult> {
  const webBase = process.env.WEB_BASE_URL || 'http://localhost:3000';
  const selector = normalizeSelector(opts.selector);
  const resp = await fetch(`${webBase}/api/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENT_API_KEY}`,
    },
    body: JSON.stringify({
      workflowId: opts.workflow_id,
      userId: opts.operator_id,
      selector,
      broadcastPerm: opts.broadcast_perm ?? false,
      deliver: opts.deliver ?? true,
      // T5 /api/push 契约（camelCase）；undefined 经 JSON.stringify 自动省略，不影响旧调用方
      presetId: opts.preset_id,
      targetMode: opts.target_mode,
      targetId: opts.target_id,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`run_push failed: ${resp.status} ${detail}`);
  }
  return resp.json();
}

export const scheduledReportsManifest: JobManifest = {
  id: '__scheduled_reports',
  // 每半小时扫描（0 分 + 30 分）——具体推送时间由 push_configs.cron_spec.time 控制，
  //   此 job 负责扫描到期的报表并触发推送。2026-08-22 改为 0,30：否则「每天 21:30」任务
  //   要到 22:00 整点才触发（旧 schedule='0 * * * *'），用户实际晚 30 分钟收到。
  schedule: '0,30 * * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__scheduled_reports';
    if (!tryAcquireLock(runningTasks, JOB_KEY, '定时报表推送', { logSkip: true })) {
      return { status: 'skipped' };
    }

    try {
      console.log('[scheduler] 定时报表推送扫描开始');

      // 1) 拉 enabled 任务（PostgREST 直查 push_configs）
      const postgrestUrl = process.env.POSTGREST_URL || 'http://postgrest:3000';
      const pgHeaders = {
        apikey: process.env.INSFORGE_API_KEY || '',
        Authorization: `Bearer ${process.env.INSFORGE_API_KEY || ''}`,
        'Content-Type': 'application/json',
      };
      const resp = await fetch(`${postgrestUrl}/push_configs?enabled=eq.true&select=*`, { headers: pgHeaders });
      if (!resp.ok) {
        console.warn('[scheduled-reports] 查询 push_configs 失败:', resp.status);
        return { status: 'error', message: `查询失败: ${resp.status}` };
      }
      const configs = (await resp.json().catch(() => [])) as Array<{
        config_id: string; name: string; cron_spec: { kind: string; time: string; weekday?: number; day?: number };
        selector_json: { kind: string; ids?: string[] }; target_mode: 'follow' | 'fixed'; target_id: number | null;
        preset_id: string; owner_wecom_id: string; last_run_date: string | null;
      }>;
      if (!Array.isArray(configs) || configs.length === 0) {
        console.log('[scheduled-reports] 无启用任务');
        return { status: 'ok', message: '无任务' };
      }

      // 「今天」按北京时区取（UTC+8），与引擎 resolveNumericValue / target-guard 同一日界——
      //   否则北京 00:00-07:59 窗口内 last_run_date（UTC 串）跨日不一致 → 重复触发/错误判定（终审 I2）
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const results: Array<{ id: string; txnId?: string; skipped?: string; error?: string; targets?: number }> = [];

      for (const cfg of configs) {
        try {
          // 2) 今日 due（日期 + 已过配置 time）且未跑（当日内补发：错过整点下一小时补上，跨日不补）
          //    终审 C2：time 必须参与判定——否则「每天 08:30」的任务在当天 00:00 就触发（推昨日累计当今日）
          const due = matchesDate(cfg.cron_spec as CronSpec, new Date()) && isTimeReached(cfg.cron_spec as CronSpec, new Date());
          const alreadyRan = cfg.last_run_date === today;
          if (!due || alreadyRan) continue;
          results.push({ id: cfg.config_id });

          // 3) 目标守卫 + 目标清单：
          //   follow = 扇出「今天落区间」的全部进行中 total 目标（每个目标一条卡片，2026-09-10 定稿）；
          //   fixed  = 锁定单目标（行为不变）。
          const guard = await checkTargetActive(cfg.target_mode, cfg.target_id ?? undefined);
          if (!guard.active) {
            console.log(`[scheduled-reports] ${cfg.name} 跳过：${guard.reason}`);
            await notifyOwnerOnce({ configId: cfg.config_id, ownerWecomId: cfg.owner_wecom_id, name: cfg.name });
            results[results.length - 1].skipped = guard.reason;
            // 守卫跳过也记当日已处理（last_run_date），避免下一小时重复提醒扫描
            await fetch(`${postgrestUrl}/push_configs?config_id=eq.${cfg.config_id}`, {
              method: 'PATCH', headers: { ...pgHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ last_run_date: today }),
            });
            continue;
          }
          const fanout = cfg.target_mode === 'follow'
            ? await listActiveTargets()
            : (cfg.target_id ? [{ target_id: cfg.target_id, name: '' }] : []);
          if (fanout.length === 0) {
            // 防御：guard 已确认有 active 目标、清单却为空（视图不一致）→ 跳过并记当日，避免刷屏
            console.log(`[scheduled-reports] ${cfg.name} 跳过：目标清单为空`);
            results[results.length - 1].skipped = '目标清单为空';
            await fetch(`${postgrestUrl}/push_configs?config_id=eq.${cfg.config_id}`, {
              method: 'PATCH', headers: { ...pgHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ last_run_date: today }),
            });
            continue;
          }

          // 4) 逐目标触发（follow 扇出全部进行中目标；fixed 单元素 = 原行为）。
          //    逐目标隔离 error：全失败 → 不写 last_run_date（下轮重试）；部分失败 → 写 last_run_date
          //    （避免已成功目标重复推送）并上抛错误供监控；全成功 → 写 txnId 清单。
          const outcomes: Array<{ targetId: number; txnId?: string; error?: string }> = [];
          for (const t of fanout) {
            try {
              const pushResult = await callRunPush({
                workflow_id: 'scheduled-report',
                operator_id: cfg.owner_wecom_id,
                selector: cfg.selector_json,
                preset_id: cfg.preset_id,
                target_mode: 'fixed',
                target_id: t.target_id,
              });
              console.log(`[scheduled-reports] ${cfg.name} target=${t.target_id} → txnId=${pushResult.txnId} groups=${pushResult.groups}`);
              outcomes.push({ targetId: t.target_id, txnId: pushResult.txnId });
            } catch (e: unknown) {
              console.error(`[scheduled-reports] ${cfg.name} target=${t.target_id} 推送失败:`, (e as Error).message);
              outcomes.push({ targetId: t.target_id, error: (e as Error).message });
            }
          }
          const okTxns = outcomes.filter((o) => o.txnId).map((o) => o.txnId as string);
          const errs = outcomes.filter((o) => o.error);
          results[results.length - 1].txnId = okTxns.join(',');
          results[results.length - 1].targets = outcomes.length;

          // 5) 回写（有成功投递即记当日已跑，防部分失败导致重复推送；全失败不写 → 下轮重试）
          if (okTxns.length > 0) {
            await fetch(`${postgrestUrl}/push_configs?config_id=eq.${cfg.config_id}`, {
              method: 'PATCH', headers: { ...pgHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ last_run_date: today, last_run_txn_id: okTxns.join(',') }),
            });
          }
          if (errs.length > 0) {
            throw new Error(`${errs.length}/${fanout.length} 个目标推送失败: ${errs.map((e) => `${e.targetId}:${e.error}`).join('; ')}`);
          }
        } catch (e: unknown) {
          console.error(`[scheduled-reports] ${cfg.name} 推送失败:`, (e as Error).message);
          results[results.length - 1].error = (e as Error).message;
        }
      }

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        return { status: 'error', message: `${failed.length}/${results.length} 个任务失败`, detail: results };
      }
      return { status: 'ok', message: `${results.length} 个任务处理`, detail: results };
    } catch (e: unknown) {
      console.error('[scheduled-reports] 异常:', (e as Error).message);
      return { status: 'error', message: (e as Error).message };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
