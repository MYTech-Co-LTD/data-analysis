import { createClient } from '@insforge/sdk';
import type { CheckType, EvalDeps } from './types';
import { SdkStore } from './store';
import { runScan } from './engine';
import { EVALUATORS } from './evaluators';
import { probe as probeFn } from './probe';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

function newClient() {
  return createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
}

// 探活重试：部署重建/网络抖动会有几十秒空窗，单次探活会误报 critical。
// 探 3 次、间隔 10s（~20s 内恢复不报）；真宕机 >20s 才 firing。
// 放 probe 包装层（非 evaluator）：prod 自动重试，evaluator 单元测试 mock probe 不受影响、不变慢。
const PROBE_ATTEMPTS = 3;
const PROBE_GAP_MS = 10_000;
async function probeWithRetry(url: string, opts?: { timeoutMs?: number; method?: string }) {
  let last = await probeFn(url, opts);
  for (let i = 1; i < PROBE_ATTEMPTS && !last.ok; i++) {
    await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
    last = await probeFn(url, opts);
  }
  return last;
}

function buildDeps(): EvalDeps {
  const client = newClient();
  return {
    now: new Date(),
    probe: (url, opts) => probeWithRetry(url, opts),
    getCredentialToken: async (sourceId) => {
      const { data, error } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', sourceId)
        .maybeSingle();
      if (error || !data?.credential_data) return null;
      try {
        const cred = JSON.parse(data.credential_data);
        return cred.token ?? null;
      } catch {
        return null;
      }
    },
    getCollectLogs: async (taskId, limit) => {
      const { data, error } = await client.database
        .from('collect_logs')
        .select('status, started_at, error_message')
        .eq('task_id', taskId)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`getCollectLogs: ${error.message}`);
      return (data ?? []) as Array<{ status: string; started_at: string; error_message: string | null }>;
    },
    getCollectTasks: async () => {
      const { data, error } = await client.database
        .from('collect_tasks')
        .select('id, name, schedule_cron, enabled, last_run_at');
      if (error) throw new Error(`getCollectTasks: ${error.message}`);
      return (data ?? []) as Array<{ id: string; name: string; schedule_cron: string; enabled: boolean; last_run_at: string | null }>;
    },
  };
}

// 各扫描桶（Phase A：service_down/token_expire 生效；后两桶 Phase B 填）
// 服务探活桶的 check_type 清单（导出供回归测试断言接线完整）：novu_health 随本桶每分钟节奏。
export const SERVICE_DOWN_BUCKET_TYPES: CheckType[] = ['service_down', 'novu_health'];

export async function runServiceDownBucket() {
  try {
    await runScan(new SdkStore(newClient()), SERVICE_DOWN_BUCKET_TYPES, buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] service_down bucket 异常:', e?.message ?? e);
  }
}

export async function runCollectTokenBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['collect_stall', 'collect_fail', 'request_fail', 'token_expire'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] collect/token bucket 异常:', e?.message ?? e);
  }
}

export async function runHourlyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_freshness', 'contact_sync'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] hourly bucket 异常:', e?.message ?? e);
  }
}

export async function runDailyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_integrity'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] daily bucket 异常:', e?.message ?? e);
  }
}
