/* eslint-disable @typescript-eslint/no-explicit-any -- shadow diff job：过渡期双源比对，U2 切换后可清理 */
// web/lib/jobs/perm-shadow/manifest.ts
// Task 13: U2 shadow diff job——全员双源权限比对，每日 cron 累积至 perm_shadow_log。
//   运行 legacy(role_id) 和 casdoor(role_codes) 两条独立路径，逐用户比对结果。
//   diff=0 连续 ≥7 天 + 白名单外 diff=0 + outbox 清空 = 切换就绪。
//   system_flags.perms_input 未切换前此 job 只做比对记录，不改权限。
// W6 sunset 守卫（Task 20）：data_permissions 已删（迁移 185 落 data_permissions_sunset 旗标）→
//   双源之一的 legacy 源不复存在，job 使命结束——读旗标 no-op（否则每日全员 RPC 404 写 ERROR 行）。
//   回滚窗口（database/rollback/167_reverse.sql）DELETE 旗标行 → job 自动恢复常态。
import { createClient } from '@insforge/sdk';
import type { JobManifest, JobResult } from '../../contracts';
import { tryAcquireLock } from '../../scheduler-lock';
import { INSFORGE_API_BASE, INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';

// 读 sunset 旗标（185 ⑤落 / 167_reverse 撤）——异常按「未 sunset」处理（fail 到原逻辑，不静默吞）
async function isPermSunsetDone(): Promise<boolean> {
  try {
    const res = await fetch(`${POSTGREST_URL}/system_flags?key=eq.data_permissions_sunset&select=value`, {
      headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const rows: Array<{ value: string }> = await res.json();
    return Array.isArray(rows) && rows[0]?.value === 'done';
  } catch {
    return false;
  }
}

// 两路径 JSONB 对比：返回存在差异的 key 列表（空=无差异）
function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
  }
  return diffs;
}

// 直连 PostgREST 调指定 RPC（与 callback 同款模式：deno/web 同网络，anon 可执行）
async function callPgrstRpc(rpcName: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${POSTGREST_URL}/rpc/${rpcName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${rpcName} ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

export const permShadowManifest: JobManifest = {
  id: '__perm_shadow_diff',
  schedule: '30 3 * * *', // 每日 03:30（避开采集/对账窗口）
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__perm_shadow_diff';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    if (await isPermSunsetDone()) {
      return { status: 'skipped', message: 'data_permissions sunset（W6，185）：legacy 源已删，shadow diff 使命结束' };
    }
    try {
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      // 取所有 active 用户（分页——review 修复：原无 range 上限，PostgREST 默认截断 1000 行，
      // 员工超 1000 后 diff 静默只覆盖前 1000 人，U2 就绪判据失真）
      const PAGE = 1000;
      const users: any[] = [];
      for (let off = 0; ; off += PAGE) {
        const { data: page, error } = await client.database
          .from('org_users')
          .select('wecom_id')
          .eq('is_active', true)
          .range(off, off + PAGE - 1);
        if (error) throw new Error(`查询用户失败: ${error.message}`);
        const rows = (page || []) as any[];
        users.push(...rows);
        if (rows.length < PAGE) break;
      }
      if (!users.length) {
        console.log('[perm-shadow] 无 active 用户，跳过');
        return { status: 'ok' };
      }

      let total = 0;
      let diffCount = 0;
      const batch: any[] = [];

      for (const u of users as any[]) {
        try {
          const [legacy, casdoor] = await Promise.all([
            callPgrstRpc('get_user_perms_legacy', { p_wecom_id: u.wecom_id }),
            callPgrstRpc('get_user_perms_casdoor', { p_wecom_id: u.wecom_id }),
          ]);
          const keys = diffKeys(legacy || {}, casdoor || {});
          total++;
          if (keys.length > 0) diffCount++;
          batch.push({
            wecom_id: u.wecom_id,
            legacy_perms: legacy,
            casdoor_perms: casdoor,
            diff_keys: keys,
          });
        } catch (e: any) {
          console.error(`[perm-shadow] ${u.wecom_id} 异常:`, e?.message ?? e);
          batch.push({
            wecom_id: u.wecom_id,
            legacy_perms: null,
            casdoor_perms: null,
            diff_keys: ['ERROR'],
          });
          total++;
          diffCount++;
        }
      }

      // 批量写入日志表
      if (batch.length > 0) {
        const { error: insertErr } = await client.database.from('perm_shadow_log').insert(batch);
        if (insertErr) console.error('[perm-shadow] 写入日志失败:', insertErr.message);
      }

      // 统计最近 7 天 diff 用户数（告警用；分页——同上 1000 行截断问题：一行=一次检查快照，
      // 7 天窗口内同一用户多条 diff 快照，截断后 Set 去重数低估）
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const distinctRecentDiffs = new Set<string>();
      for (let off = 0; ; off += PAGE) {
        const { data: page, error: recentErr } = await client.database
          .from('perm_shadow_log')
          .select('wecom_id')
          .gt('checked_at', sevenDaysAgo)
          .neq('diff_keys', '{}')
          .range(off, off + PAGE - 1);
        if (recentErr) throw new Error(`查询近 7 天 diff 失败: ${recentErr.message}`);
        const rows = (page || []) as any[];
        rows.forEach((r: any) => { if (r?.wecom_id) distinctRecentDiffs.add(r.wecom_id); });
        if (rows.length < PAGE) break;
      }
      const recentDiffUsers = distinctRecentDiffs.size;

      const msg = `[perm-shadow] 完成：${total} 用户，${diffCount} diff；近7天累计 ${recentDiffUsers} 用户有 diff`;
      console.log(msg);
      if (diffCount > 0) {
        console.warn(`[perm-shadow] ⚠️ ${diffCount} 用户 legacy vs casdoor 不一致`);
      }

      return {
        status: 'ok',
        message: msg,
        detail: { total, diffCount, recentDiffUsers },
      };
    } catch (e: any) {
      console.error('[perm-shadow] job 异常:', e?.message ?? e);
      return { status: 'error', message: e?.message ?? String(e) };
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  },
};
