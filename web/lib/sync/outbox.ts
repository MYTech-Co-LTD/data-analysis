// web/lib/sync/outbox.ts
// Outbox drain 逻辑：从 sync_outbox 取待重放项→执行→标记 done/更新 attempts。
// spec §4.5: outbox 重放（幂等键 wecom_id+action+day）；失败入 outbox 计数。
// drain 先清 outbox 再写新操作（保证不丢不重）。

import { POSTGREST_URL } from '../jobs/env';
import {
  provisionUser,
  assignRoles,
  disableUser,
  type CasdoorUser,
} from './casdoor-client';

const PG_H = (): Record<string, string> => {
  const KEY = process.env.INSFORGE_API_KEY!;
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
};

// ---- outbox 行类型 ----
export interface OutboxRow {
  id: number;
  wecom_id: string;
  action: 'provision' | 'assign_role' | 'disable' | 'sync_mirror';
  payload: Record<string, unknown>;
  day: string;
  attempts: number;
  done: boolean;
  error: string | null;
  created_at: string;
}

// ---- 入队（写新操作前调用，幂等键防重） ----

/**
 * 入队 outbox 操作。幂等键 (wecom_id, action, day)——重跑不重复创建。
 * 返回 { enqueued: boolean; existing?: OutboxRow }
 */
export async function enqueue(
  wecomId: string,
  action: OutboxRow['action'],
  payload: Record<string, unknown> = {},
): Promise<{ enqueued: boolean; existing?: OutboxRow }> {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  // 先查是否已存在（幂等）
  const existing: OutboxRow[] = await fetch(
    `${POSTGREST_URL}/sync_outbox?select=*&wecom_id=eq.${encodeURIComponent(wecomId)}&action=eq.${action}&day=eq.${today}`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  if (existing.length > 0) {
    return { enqueued: false, existing: existing[0] };
  }

  const resp = await fetch(`${POSTGREST_URL}/sync_outbox`, {
    method: 'POST',
    headers: PG_H(),
    body: JSON.stringify({
      wecom_id: wecomId,
      action,
      payload,
      day: today,
    }),
  });

  if (!resp.ok) {
    console.error('[outbox] enqueue failed:', wecomId, action, await resp.text());
    return { enqueued: false };
  }

  return { enqueued: true };
}

// ---- drain（取待重放项→执行→标记 done） ----

export interface DrainResult {
  total: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  errors: Array<{ id: number; wecom_id: string; action: string; error: string }>;
}

/** 单条 outbox 最大重试次数，达到即死信封存（review 修复：原无限重试，操作永久失败会卡死队首且无终态） */
export const MAX_ATTEMPTS = 10;

/**
 * drain：取所有未完成 outbox 项→逐条执行→成功标 done、失败更新 attempts+error。
 * 每次 drain 最多处理 maxItems 条（防积压时一次处理太多）。
 * 单条达到 MAX_ATTEMPTS → 标 done=true + error='DEAD_LETTER: <原因>' 封存，
 *   计入 deadLettered 并出现在 errors（调用方须据 deadLettered 告警——
 *   死信操作不会再有重试路径，静默丢弃即数据丢失）。
 */
export async function drain(maxItems = 100): Promise<DrainResult> {
  const pending: OutboxRow[] = await fetch(
    `${POSTGREST_URL}/sync_outbox?select=*&done=eq.false&order=created_at.asc&limit=${maxItems}`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  const result: DrainResult = { total: pending.length, succeeded: 0, failed: 0, deadLettered: 0, errors: [] };

  for (const row of pending) {
    const execResult = await executeOutboxRow(row);

    if (execResult.ok) {
      // 标记 done
      await fetch(`${POSTGREST_URL}/sync_outbox?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: PG_H(),
        body: JSON.stringify({ done: true, updated_at: new Date().toISOString() }),
      });
      result.succeeded++;
    } else {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // 死信封存：不再重试（防队首毒药卡死后续积压）；error 带 DEAD_LETTER 标记供排查/告警
        await fetch(`${POSTGREST_URL}/sync_outbox?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: PG_H(),
          body: JSON.stringify({
            done: true,
            attempts,
            error: `DEAD_LETTER: ${execResult.error ?? 'unknown'}`,
            updated_at: new Date().toISOString(),
          }),
        });
        result.deadLettered++;
        result.errors.push({
          id: row.id, wecom_id: row.wecom_id, action: row.action,
          error: `DEAD_LETTER (attempts=${attempts}): ${execResult.error ?? 'unknown'}`,
        });
      } else {
        // 更新 attempts + error
        await fetch(`${POSTGREST_URL}/sync_outbox?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: PG_H(),
          body: JSON.stringify({
            attempts,
            error: execResult.error,
            updated_at: new Date().toISOString(),
          }),
        });
        result.failed++;
        result.errors.push({ id: row.id, wecom_id: row.wecom_id, action: row.action, error: execResult.error ?? 'unknown' });
      }
    }
  }

  return result;
}

/** 执行单条 outbox 行 */
async function executeOutboxRow(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  const { wecom_id: wecomId, action, payload } = row;

  switch (action) {
    case 'provision': {
      const user: CasdoorUser = {
        name: wecomId,
        displayName: (payload.display_name as string) ?? wecomId,
        email: payload.email as string | undefined,
        phone: payload.phone as string | undefined,
        groups: payload.groups as string[] | undefined,
      };
      const r = await provisionUser(user);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }

    case 'assign_role': {
      const roleCodes = payload.role_codes as string[] ?? [];
      const r = await assignRoles(wecomId, roleCodes);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }

    case 'disable': {
      const r = await disableUser(wecomId);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }

    case 'sync_mirror': {
      // sync_mirror 由 drift job 处理，outbox drain 不执行
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown_action: ${action}` };
  }
}

/**
 * 获取 outbox 积压统计（供告警判断）
 */
export async function getBacklogStats(): Promise<{
  total: number;
  oldest_hours: number | null;
}> {
  const rows: Array<{ created_at: string }> = await fetch(
    `${POSTGREST_URL}/sync_outbox?select=created_at&done=eq.false&order=created_at.asc`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  if (rows.length === 0) return { total: 0, oldest_hours: null };

  const oldest = new Date(rows[0].created_at).getTime();
  const hours = (Date.now() - oldest) / 3600_000;
  return { total: rows.length, oldest_hours: hours };
}
