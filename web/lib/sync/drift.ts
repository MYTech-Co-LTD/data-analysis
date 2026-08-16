// web/lib/sync/drift.ts
// Drift 三向对账（spec §4.5）：每日 job 执行，产出 diff1/diff2/diff3 报告。
//   diff1（C−E manual 除外）= Casdoor 手工配置→回写镜像标 manual，永不反向覆盖
//   diff2（E−C）= 写失败→outbox 重放，>48h 页级告警
//   diff3（C−M）= 镜像滞后→回写，24h 未收敛告警
// manual 翻转竞态防护：仅当该用户 outbox 清空后 diff 持续 ≥2 对账周期才翻转。

import { POSTGREST_URL } from '../jobs/env';
import { getUserRoles } from './casdoor-client';
import { getBacklogStats } from './outbox';

const PG_H = (): Record<string, string> => {
  const KEY = process.env.INSFORGE_API_KEY!;
  return { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
};

// ---- diff 类型 ----

export interface Diff1Item {
  wecom_id: string;
  name: string | null;
  local_codes: string[];
  casdoor_roles: string[];
  note: string;
}

export interface Diff2Item {
  wecom_id: string;
  action: string;
  attempts: number;
  hours_pending: number;
  error: string | null;
}

export interface Diff3Item {
  wecom_id: string;
  name: string | null;
  local_codes: string[];
  casdoor_roles: string[];
  hours_since_sync: number;
}

export interface DriftReport {
  diff1: Diff1Item[];
  diff2: Diff2Item[];
  diff3: Diff3Item[];
  backlog: { total: number; oldest_hours: number | null };
  checked_at: string;
}

// ---- diff2：outbox 积压（纯本地查询） ----

async function computeDiff2(): Promise<Diff2Item[]> {
  const rows: Array<{
    wecom_id: string; action: string; attempts: number;
    created_at: string; error: string | null;
  }> = await fetch(
    `${POSTGREST_URL}/sync_outbox?select=wecom_id,action,attempts,created_at,error&done=eq.false&created_at=lt.${new Date(Date.now() - 48 * 3600_000).toISOString()}`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  return rows.map(r => ({
    wecom_id: r.wecom_id,
    action: r.action,
    attempts: r.attempts,
    hours_pending: (Date.now() - new Date(r.created_at).getTime()) / 3600_000,
    error: r.error,
  }));
}

// ---- diff3：镜像滞后（本地 synced_at 超时） ----

async function computeDiff3(): Promise<Diff3Item[]> {
  const rows: Array<{
    wecom_id: string; name: string | null;
    role_codes: string[]; casdoor_synced_at: string | null;
  }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name,role_codes,casdoor_synced_at&is_active=eq.true&casdoor_synced_at=not.is.null&casdoor_synced_at=lt.${new Date(Date.now() - 24 * 3600_000).toISOString()}`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  const result: Diff3Item[] = [];
  for (const row of rows) {
    // 从 Casdoor 拉最新角色做对比
    const casdoorResult = await getUserRoles(row.wecom_id);
    if (!casdoorResult.ok || !casdoorResult.roles) continue;

    const localSorted = [...(row.role_codes ?? [])].sort();
    const remoteSorted = [...casdoorResult.roles].sort();
    const isDifferent = JSON.stringify(localSorted) !== JSON.stringify(remoteSorted);

    if (isDifferent) {
      result.push({
        wecom_id: row.wecom_id,
        name: row.name,
        local_codes: row.role_codes ?? [],
        casdoor_roles: casdoorResult.roles,
        hours_since_sync: (Date.now() - new Date(row.casdoor_synced_at!).getTime()) / 3600_000,
      });
    }
  }
  return result;
}

// ---- diff1：Casdoor 手工配置（C−E，manual 除外） ----
// diff1 = Casdoor 有角色但本地镜像不一致，且 casdoor_writer != 'manual'
// 需逐用户查 Casdoor（限 active + synced + 非 manual），所以只在必要时跑

async function computeDiff1(): Promise<Diff1Item[]> {
  // 拉 active + 已同步 + 非 manual 用户
  const users: Array<{
    wecom_id: string; name: string | null;
    role_codes: string[]; casdoor_writer: string;
  }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name,role_codes,casdoor_writer&is_active=eq.true&casdoor_synced_at=not.is.null&casdoor_writer=neq.manual`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  const result: Diff1Item[] = [];
  for (const user of users) {
    const casdoorResult = await getUserRoles(user.wecom_id);
    if (!casdoorResult.ok || !casdoorResult.roles) continue;

    const localSorted = [...(user.role_codes ?? [])].sort();
    const remoteSorted = [...casdoorResult.roles].sort();
    const isDifferent = JSON.stringify(localSorted) !== JSON.stringify(remoteSorted);

    if (isDifferent) {
      result.push({
        wecom_id: user.wecom_id,
        name: user.name,
        local_codes: user.role_codes ?? [],
        casdoor_roles: casdoorResult.roles,
        note: 'Casdoor 侧角色与本地镜像不一致（非 manual 用户）→ 可能是 Casdoor UI 手工配置',
      });
    }
  }
  return result;
}

// ---- 主入口：跑完整 drift 报告 ----

/**
 * 执行 drift 三向对账。返回完整报告。
 * 告警阈值：diff1 任何 → 告警；diff2 >48h → 告警；diff3 >24h → 告警。
 * manual 翻转竞态防护：outbox 有未完成项时不翻转任何用户为 auto。
 */
export async function runDriftReport(): Promise<DriftReport> {
  // diff2 先跑（纯本地，快），用于判断 outbox 积压
  const [diff2, backlog] = await Promise.all([
    computeDiff2(),
    getBacklogStats(),
  ]);

  // diff1 和 diff3 需要调 Casdoor API（可能慢），并行跑
  const [diff1, diff3] = await Promise.all([
    computeDiff1(),
    computeDiff3(),
  ]);

  return {
    diff1,
    diff2,
    diff3,
    backlog,
    checked_at: new Date().toISOString(),
  };
}

/**
 * 判断是否需要告警。返回告警消息数组（空=无需告警）。
 */
export function assessAlerts(report: DriftReport): string[] {
  const alerts: string[] = [];

  // diff1: Casdoor 手工配置
  if (report.diff1.length > 0) {
    alerts.push(
      `[drift-diff1] ${report.diff1.length} 用户 Casdoor 侧有手工配置（非 manual 用户）：${report.diff1.map(d => d.wecom_id).join(', ')}`,
    );
  }

  // diff2: outbox 积压 >48h
  if (report.diff2.length > 0) {
    alerts.push(
      `[drift-diff2] ${report.diff2.length} 条 outbox 积压 >48h（写失败待重放）：${report.diff2.map(d => `${d.wecom_id}/${d.action}(${d.hours_pending.toFixed(0)}h)`).join(', ')}`,
    );
  }

  // diff3: 镜像滞后 >24h
  if (report.diff3.length > 0) {
    alerts.push(
      `[drift-diff3] ${report.diff3.length} 用户镜像滞后 >24h：${report.diff3.map(d => `${d.wecom_id}(${d.hours_since_sync.toFixed(0)}h)`).join(', ')}`,
    );
  }

  return alerts;
}

/**
 * manual 翻转竞态检查：该用户 outbox 是否清空。
 * spec: 仅当该用户 outbox 清空后 diff 持续 ≥2 对账周期才翻转。
 */
export async function canFlipToAuto(wecomId: string): Promise<boolean> {
  const rows: Array<{ id: number }> = await fetch(
    `${POSTGREST_URL}/sync_outbox?select=id&wecom_id=eq.${encodeURIComponent(wecomId)}&done=eq.false&limit=1`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  return rows.length === 0; // outbox 清空才允许翻转
}
