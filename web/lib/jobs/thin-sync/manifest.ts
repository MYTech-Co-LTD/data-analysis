// web/lib/jobs/thin-sync/manifest.ts
// 薄同步 job（spec §4.5 / Task 12）——2026-08-19 功能边界收死（用户裁定）：仅同步企微组织架构。
//   ✅ 允许（组织架构镜像三部曲，均为 Casdoor 侧组织投影）：
//     ① provisioning(JIT 建户，新员工进企微 → 可登录)
//     ② disable(离职，含 token_blacklist；Casdoor 无户 = 等价 deny 直接标终态)
//     ③ sync_groups(部门组对账)
//   ❌ 禁止（单写者 = Casdoor UI / 管理脚本，薄同步永不触碰）：
//     - 角色/权限/数据范围写入（assign_role 已删，2026-08-18）
//     - maps_branch_group / 任何权限语义表（归 scope-packs 同步与迁移）
//     - 新增任何非组织架构动作：加之前先改本注释 + spec，否则违反单写者纪律
//   outbox 仅承载 provision/disable 两类组织架构动作的重试；历史 assign_role 死信已一次性清除
//   （2026-08-19 清理 45 条，动作已废除无重试意义）。
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { POSTGREST_URL, INSFORGE_API_KEY } from '../env';
import { runningTasks } from '../state';
import { provisionUser, disableUser, syncUserGroups, casdoorGroupsFromDepts } from '../../sync/casdoor-client';
import { enqueue, drain, type DrainResult } from '../../sync/outbox';

const PG_H = (): Record<string, string> => ({
  apikey: INSFORGE_API_KEY!,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
});

// ---- 离职四 sink（最高优先级） ----
// 检测 is_active=false 且 Casdoor 未 disable 的用户 → disable + outbox
async function actionDisable(): Promise<{ processed: number; enqueued: number }> {
  // 查 is_active=false 但 casdoor_writer 不是 'disabled' 的用户
  const inactive: Array<{ wecom_id: string; name: string | null }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name&is_active=eq.false&casdoor_writer=neq.disabled`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  let enqueued = 0;
  for (const user of inactive) {
    const result = await disableUser(user.wecom_id);
    if (!result.ok && result.error !== 'user_not_found_in_casdoor') {
      // 写失败 → 入 outbox（B6：只在实际入队时计数；下一轮 is_active=false 仍会被重新扫描，不丢）
      const q = await enqueue(user.wecom_id, 'disable', { name: user.name });
      if (q.enqueued) enqueued++;
      else console.error('[thin-sync] disable 失败且 outbox 入队失败，下轮重试:', user.wecom_id);
      continue;
    }
    // 成功，或 user_not_found（Casdoor 无此户 = 等价 deny，最强禁用；2026-08-19 DongPingXia_1
    // 死循环修复：旧 userid 无 Casdoor 户的离职行直接标终态，不再报错/入队/重试）
    if (!result.ok) {
      console.log(`[thin-sync] disable: ${user.wecom_id} Casdoor 无户，等价 deny 标终态`);
    }
    // 标记 casdoor_writer='disabled'（+成功路径写 token_blacklist，离职四 sink①，2026-08-17：
      // middleware 按 user_id 拉黑，旧 7 天 JWT web API 面即刻拒；expires_at=7 天 JWT 窗口后
      // 由 cleanup-blacklist 自然清理。select-then-insert 幂等，重跑不重复拉黑。）
      await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(user.wecom_id)}`, {
        method: 'PATCH',
        headers: PG_H(),
        body: JSON.stringify({ casdoor_writer: 'disabled' }),
      }).catch(() => {});
      const existingBl: Array<{ id: string }> = await fetch(
        `${POSTGREST_URL}/token_blacklist?user_id=eq.${encodeURIComponent(user.wecom_id)}&select=id`,
        { headers: PG_H(), cache: 'no-store' },
      ).then(r => r.json()).catch(() => []);
      if (existingBl.length === 0) {
        await fetch(`${POSTGREST_URL}/token_blacklist`, {
          method: 'POST',
          headers: PG_H(),
          body: JSON.stringify({
            token_hash: `sub:${user.wecom_id}`,
            user_id: user.wecom_id,
            expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
            reason: 'offboard',
          }),
        }).catch(e => console.error('[thin-sync] blacklist 写入失败（is_active 软校验仍兑底）:', user.wecom_id, e));
      }
  }
  return { processed: inactive.length, enqueued };
}

// ---- 部门 id → 名称 映射（组对账/建户共用） ----
// org_departments.id 是企微部门 id（varchar，如 '63'），name 与 Casdoor 组名同源（企微部门树）。
async function fetchDeptNameMap(): Promise<Map<string, string>> {
  try {
    const depts: Array<{ id?: string; name?: string }> = await fetch(
      `${POSTGREST_URL}/org_departments?select=id,name&is_active=eq.true`,
      { headers: PG_H(), cache: 'no-store' },
    ).then(r => r.json()).catch(() => []);
    if (!Array.isArray(depts)) return new Map();
    return new Map(depts.map((d) => [String(d.id ?? ''), String(d.name ?? '')]));
  } catch {
    return new Map();
  }
}

// ---- provisioning JIT（Casdoor 建户） ----
// 对 active 但从未同步过的用户（casdoor_synced_at IS NULL）→ provision
async function actionProvision(): Promise<{ processed: number; enqueued: number }> {
  const unsynced: Array<{
    wecom_id: string; name: string | null;
    department_ids: string[];
  }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids&is_active=eq.true&casdoor_synced_at=is.null`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);

  // 2026-08-17（陈润补挂根因）：曾只传 name/displayName 不传 groups → 新用户 Casdoor 全空组 →
  // 登录 C2 fail-close 拒绝。department_ids 查出来了但没用上——现在映射成组随建户写入。
  const deptNames = await fetchDeptNameMap();

  let enqueued = 0;
  for (const user of unsynced) {
    const groups = casdoorGroupsFromDepts(
      (Array.isArray(user.department_ids) ? user.department_ids : [])
        .map((id) => deptNames.get(String(id)))
        .filter((n): n is string => !!n),
    );
    const result = await provisionUser({
      name: user.wecom_id,
      displayName: user.name ?? user.wecom_id,
      groups,
    });

    // B5（review 修复）：synced_at 只在「有重试路径」时标记——成功，或失败但已入 outbox。
    // 失败且 outbox 入队也不成功（如 synced_outbox 挂）→ 不标 synced_at → 下一轮该用户仍在
    // casdoor_synced_at=is.null 集合里，直接重试 provision（JIT 幂等，不会重复建户，无数据丢失）。
    // 原实现无条件标 synced_at：Casdoor 故障期把用户标成已同步 → 永不再 provision（静默丢户）。
    if (!result.ok) {
      const q = await enqueue(user.wecom_id, 'provision', { display_name: user.name });
      if (q.enqueued) enqueued++;
      else {
        console.error('[thin-sync] provision 失败且 outbox 入队失败，保留 unsynced 待下轮重试:', user.wecom_id);
        continue;
      }
    }
    await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(user.wecom_id)}`, {
      method: 'PATCH',
      headers: PG_H(),
      body: JSON.stringify({ casdoor_synced_at: new Date().toISOString() }),
    }).catch(() => {});
  }

  return { processed: unsynced.length, enqueued };
}

// ---- 组对账（2026-08-17 陈润补挂自愈） ----
// 对 active 且有 department_ids 的用户，确保 Casdoor groups 含期望组（只补缺失，不删手配）。
// 逐轮重跑幂等：已含则零改动；不依赖 outbox（失败下轮自愈），不新增 outbox 动作类型。
async function actionSyncGroups(): Promise<{ processed: number; changed: number }> {
  const users: Array<{ wecom_id: string; name: string | null; department_ids: string[] }> = await fetch(
    `${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids&is_active=eq.true`,
    { headers: PG_H(), cache: 'no-store' },
  ).then(r => r.json()).catch(() => []);
  const deptNames = await fetchDeptNameMap();

  let changed = 0;
  for (const user of (Array.isArray(users) ? users : [])) {
    const deptIds = Array.isArray(user.department_ids) ? user.department_ids : [];
    if (deptIds.length === 0) continue;
    const groups = casdoorGroupsFromDepts(
      deptIds.map((id) => deptNames.get(String(id))).filter((n): n is string => !!n),
    );
    if (groups.length === 0) continue; // 部门都查不到名 → 跳过（不误写空组）

    const result = await syncUserGroups(user.wecom_id, groups);
    if (!result.ok) {
      // 仅记录：user_not_found 归 provision 管，API 故障下轮自愈，均不入 outbox
      console.error('[thin-sync] sync_groups failed:', user.wecom_id, result.error);
      continue;
    }
    if (result.changed) {
      changed++;
      console.log(`[thin-sync] sync_groups 补挂 ${user.wecom_id}: ${groups.join(',')}`);
    }
  }

  return { processed: (Array.isArray(users) ? users : []).length, changed };
}

// ---- main manifest ----
export const thinSyncManifest: JobManifest = {
  id: '__thin_sync',
  // 每 30 分钟跑一次（outbox drain + 三动作）
  schedule: '*/30 * * * *',
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__thin_sync';
    if (!tryAcquireLock(runningTasks, JOB_KEY, '薄同步')) return { status: 'skipped' };

    try {
      console.log('[thin-sync] 开始薄同步 cycle');

      // ① 先 drain outbox（积压优先）
      let drainResult: DrainResult = { total: 0, succeeded: 0, failed: 0, deadLettered: 0, errors: [] };
      try {
        drainResult = await drain(50);
        if (drainResult.total > 0) {
          console.log(`[thin-sync] outbox drain: ${drainResult.succeeded}/${drainResult.total} succeeded`);
        }
      } catch (e) {
        console.error('[thin-sync] outbox drain error:', (e as Error).message);
      }

      // ② 离职四 sink（最高优先级）
      let disableResult = { processed: 0, enqueued: 0 };
      try {
        disableResult = await actionDisable();
      } catch (e) {
        console.error('[thin-sync] disable action error:', (e as Error).message);
      }

      // ③ provisioning JIT
      let provisionResult = { processed: 0, enqueued: 0 };
      try {
        provisionResult = await actionProvision();
      } catch (e) {
        console.error('[thin-sync] provision action error:', (e as Error).message);
      }

      // ④ 组对账（2026-08-17 陈润补挂：provision 漏组自愈 + 存量空组补挂）
      let groupsResult = { processed: 0, changed: 0 };
      try {
        groupsResult = await actionSyncGroups();
      } catch (e) {
        console.error('[thin-sync] sync_groups action error:', (e as Error).message);
      }

      // 汇总
      const totalEnqueued = disableResult.enqueued + provisionResult.enqueued;
      const summary = [
        `drain=${drainResult.succeeded}/${drainResult.total}`,
        `disable=${disableResult.processed}(fail=${disableResult.enqueued})`,
        `provision=${provisionResult.processed}(fail=${provisionResult.enqueued})`,
        `groups=${groupsResult.changed}/${groupsResult.processed}`,
      ].join(' | ');

      console.log(`[thin-sync] cycle 完成: ${summary}`);

      // 有新失败入 outbox → 告警
      if (totalEnqueued > 0) {
        await notifyWecom(
          '⚠️ 薄同步有操作失败',
          `**新增 outbox**: ${totalEnqueued}\n${summary}`,
        ).catch(() => {});
      }

      // 死信告警（review 修复：outbox 达 MAX_ATTEMPTS 封存后无重试路径，必须响亮告警，否则静默丢操作）
      if (drainResult.deadLettered > 0) {
        const deadRows = drainResult.errors
          .filter((e) => e.error.startsWith('DEAD_LETTER'))
          .map((e) => `- ${e.wecom_id} ${e.action}: ${e.error}`)
          .join('\n');
        await notifyWecom(
          '⛔ 薄同步 outbox 死信',
          `**死信 ${drainResult.deadLettered} 条（已封存，不再自动重试）**\n${deadRows}\n\n请人工介入（检查 Casdoor 连接/用户状态）后手动处置或重试。`,
        ).catch(() => {});
      }

      return { status: 'ok', message: summary };
    } catch (e) {
      console.error('[thin-sync] cycle 异常:', (e as Error).message);
      return { status: 'error', message: (e as Error).message };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
