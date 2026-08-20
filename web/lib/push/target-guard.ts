// web/lib/push/target-guard.ts
// 目标结束守卫（spec §3.4）：触发前检查数据源目标——
//   follow：视图「今天落区间」是否有行；fixed：视图 target_id+status=active 是否有行（targets 表 RLS 拦 anon，不能直查）。
//   不 active → 跳过本次 + owner 一次性企微提醒（last_guard_notice_at 24h 防重）。

import { sendWecomMarkdown } from '../wecom-send';

function pg() {
  const url = process.env.POSTGREST_URL || '';
  const key = process.env.POSTGREST_ANON_KEY || process.env.INSFORGE_API_KEY || '';
  return { url, headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' } };
}

export async function checkTargetActive(
  mode: 'follow' | 'fixed',
  targetId: number | undefined,
): Promise<{ active: boolean; reason: string }> {
  const { url, headers } = pg();
  if (!url) return { active: false, reason: 'POSTGREST_URL 未配置' };
  try {
    if (mode === 'fixed') {
      if (!targetId) return { active: false, reason: 'fixed 模式缺 target_id' };
      // Critical-1：targets 表 SELECT 被 RLS 拦死（anon 恒空集，生产实测 200 []），
      // 改查视图（与引擎 fixed 取值完全同路径，anon 可见）：target_id + status=eq.active。
      const resp = await fetch(
        `${url}/report_achievement_gen?select=metric_code&target_id=eq.${targetId}&status=eq.active&limit=1`,
        { headers },
      );
      const rows = await resp.json().catch(() => []);
      return Array.isArray(rows) && rows.length > 0
        ? { active: true, reason: '' }
        : { active: false, reason: `目标 ${targetId} 已结束或不可见（status=非 active 或不在视图范围）` };
    }
    // follow：与引擎取值同口径（今天落区间），service 侧探测（不涉敏感数据，有行即可）
    // 「今天」按北京时区取（UTC+8），与引擎 resolveNumericValue 同一日界——否则北京 0-8 点误判昨日
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const resp = await fetch(
      `${url}/report_achievement_gen?select=metric_code&status=eq.active`
      + `&start_date=lte.${today}&end_date=gte.${today}&limit=1`,
      { headers },
    );
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0
      ? { active: true, reason: '' }
      : { active: false, reason: '无进行中目标（今天不在任何 active 目标周期内）' };
  } catch (e) {
    return { active: false, reason: `守卫查询失败：${String(e)}` };
  }
}

/** 一次性 owner 提醒（24h 防重，DB last_guard_notice_at） */
export async function notifyOwnerOnce(config: { configId: string; ownerWecomId: string; name: string }): Promise<void> {
  const { url, headers } = pg();
  if (!url) return;
  try {
    const read = await fetch(`${url}/push_configs?config_id=eq.${config.configId}&select=last_guard_notice_at`, { headers });
    const rows = await read.json().catch(() => []);
    const last = Array.isArray(rows) && rows[0]?.last_guard_notice_at ? new Date(rows[0].last_guard_notice_at).getTime() : 0;
    if (Date.now() - last < 24 * 3600_000) return; // 24h 内已提醒

    await fetch(`${url}/push_configs?config_id=eq.${config.configId}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_guard_notice_at: new Date().toISOString() }),
    });

    await sendWecomMarkdown(
      config.ownerWecomId,
      `⏸️ 推送任务「${config.name}」已暂停：数据源目标已结束（无进行中目标）。请在推送任务管理页更换目标或等待新目标建立。`,
    );
  } catch (e) {
    console.error('[target-guard] owner 提醒失败', e);
  }
}
