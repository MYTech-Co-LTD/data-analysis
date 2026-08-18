// web/lib/jobs/reconcile-groups/manifest.ts
// Task 10: W2 独立期望源「人→门店」对账 job（spec §5.8 H10 / M4 七天门禁——W2 退出判据）。
// 每日 03:37（错开既有采集 8-23 每5min / 对账 02:00 / perm-shadow 03:30 / 门店树 03:17 窗口）：
//   期望源（独立，防循环自证 H10）= dim_war_zone 考核门店 × org_users.position 店长/督导岗位清单
//     —— 均为企微/lemeng dim 原始数据，不经 Group 树；org_departments 投影已被 spec 降级为被测对象，禁用。
//   ⚠ 2026-08-18 口径脱钩：本 job「实际集」仍用 expandGroupsToBranches（组织架构推导）——门店数据范围
//   已改为「范围|X 资源唯一真相」，本 job 仅剩组织卫生审计价值（企微树 vs 岗位覆盖漂移告警），
//   missing/extra 不再代表授权一致性（授权以范围|X 资源为准），勿误读为授权证明。
//   实际集 = org_users.groups（F9 投影列）经 T9 expandGroupsToBranches 三态展开。
//   差异分级（classifyMembershipDiff）→ UPSERT group_reconcile_history（date PK）→ red>0 发企微 collect_fail 同款告警。
// ⚠️ 数据现实约束（详见 report）：库内不存在独立于 Group 链的「精确人→门店」表（org_departments 被禁），
//   期望集按 spec §5.8 允许的「岗位清单或考核分区清单」形态落地为**覆盖语义**：
//   伪用户 __manager_coverage__ 的 missing = 无任何店长/督导覆盖的考核门店（E 红）；挂门店组但不在
//   岗位清单的用户走 M 级（提示补录）。per-user 精确期望待独立「督导→战区」源（如 HR 表）接入后升级。
import { createClient } from '@insforge/sdk';
import type { JobManifest, JobResult } from '../../contracts';
import { notifyWecom } from '../../notify';
import { tryAcquireLock } from '../../scheduler-lock';
import { expandGroupsToBranches } from '../../sync/group-expand';
import { INSFORGE_API_BASE, INSFORGE_API_KEY, POSTGREST_URL } from '../env';
import { runningTasks } from '../state';
import { buildReconcileRow, classifyMembershipDiff, gate7days, type WhitelistEntry } from '../../reconcile-groups';

// 覆盖语义的伪用户（classifyMembershipDiff 契约是 per-user，覆盖矩阵以此行喂入；禁撞真实 wecom_id）
export const COVERAGE_USER = '__manager_coverage__';
// 门店责任人岗位正则：企微真实岗位形态 = 区域经理（2026-08-17 实测 46 用户 position 只有
// 区域经理×10/部门负责人×1/执行副总×1，无店长/督导——店长不在通讯录范围）；
// 店长/督导/主管保留——未来门店岗上线后自动生效。
// 不纳入部门负责人/执行副总：职能高管挂总经办=全店视野，纳入会稀释覆盖检查力度（missing 失去拉力）。
const POSITION_PATTERN = /店长|督导|主管|区域经理/;   // spec §5.8「店长/督导岗位清单」形态 + 实况岗位

interface HistoryRow { whitelist_outside_diff: number; red_count: number; detail?: { whitelist?: WhitelistEntry[] } | null }

async function pgrstGet<T>(path: string): Promise<T[]> {
  // PostgREST 直连读（裸数组）：网关（INSFORGE_API_BASE）不代理裸表路径（404，生产首跑实测），
  // 固化 POSTGREST_URL 直连 + apikey 头（env.ts 注释同款口径：RPC/裸表均直连）
  const res = await fetch(`${POSTGREST_URL}${path}`, {
    headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`pgrst ${path} ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  return Array.isArray(json) ? (json as T[]) : [];
}

export const reconcileGroupsManifest: JobManifest = {
  id: '__reconcile_groups',
  schedule: '37 3 * * *', // 每日 03:37（Task 10 plan Step 5 指定）
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__reconcile_groups';
    if (!tryAcquireLock(runningTasks, JOB_KEY, `任务 ${JOB_KEY}`)) return { status: 'skipped' };
    try {
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

      // ---- 期望源①：dim_war_zone 考核门店（独立 dim 数据，与 Group 链无涉）----
      const warZones = await pgrstGet<{ war_zone: string }>(
        '/dim_war_zone?select=war_zone&is_assessed=eq.true',
      );
      const assessedZones = new Set(warZones.map((w) => w.war_zone));
      const branches = await pgrstGet<{ branch_number: string; first_level_region: string | null }>(
        '/dim_branch?select=branch_number,first_level_region&is_active=eq.true&limit=10000',
      );
      const assessedBranches = branches
        .filter((b) => b.first_level_region && assessedZones.has(b.first_level_region))
        .map((b) => b.branch_number);

      // 期望源完整性守卫（采集完整性规则同款精神）其一：考核集为空 = 期望源缺数（dim 未同步/dev 库空），
      // 空集会让覆盖 diff 永远 0 → 7 天门禁被静默欺骗。此时不落「绿」行（不污染门禁窗口），报错+告警。
      if (!assessedZones.size || !assessedBranches.length) {
        const msg = `期望源考核集为空：assessedZones=${assessedZones.size} assessedBranches=${assessedBranches.length}（dim_war_zone/dim_branch 未同步？）`;
        await notifyWecom('⚠️ 组对账期望源为空（Task10）', msg);
        throw new Error(msg);
      }

      // ---- 期望源② + 实际集：org_users（position=岗位清单；groups=被测投影）----
      // 分页拉全量（perm-shadow review 教训：PostgREST 默认截断 1000 行静默只覆盖前段）
      const PAGE = 1000;
      const users: { wecom_id: string; position: string | null; groups: string[] }[] = [];
      for (let off = 0; ; off += PAGE) {
        const { data: page, error } = await client.database
          .from('org_users')
          .select('wecom_id,position,groups')
          .eq('is_active', true)
          .range(off, off + PAGE - 1);
        if (error) throw new Error(`查询 org_users 失败: ${error.message}`);
        const rows = (page ?? []) as typeof users;
        users.push(...rows);
        if (rows.length < PAGE) break;
      }
      // 期望源完整性守卫其二：用户集为空（org_users 未同步）同上——不落绿行，报错+告警。
      if (!users.length) {
        const msg = '期望源用户集为空：org_users 无 active 行（通讯录未同步？）';
        await notifyWecom('⚠️ 组对账期望源为空（Task10）', msg);
        throw new Error(msg);
      }

      // 实际集：逐用户 groups 展开（T9 三态）；展开 fail-close 的用户记入 expandErrors（不产出门店范围）
      const actual: { user: string; branch_numbers: string[] }[] = [];
      const expandErrors: { user: string; error: string }[] = [];
      const perUserBranches = new Map<string, string[]>();
      for (const u of users) {
        const groups = Array.isArray(u.groups) ? u.groups : [];
        const r = await expandGroupsToBranches(groups);
        if (!r.ok) {
          expandErrors.push({ user: u.wecom_id, error: r.error ?? 'unknown' });
          perUserBranches.set(u.wecom_id, []);
          continue;
        }
        perUserBranches.set(u.wecom_id, [...r.branch_nums]);
        if (r.branch_nums.length) actual.push({ user: u.wecom_id, branch_numbers: [...r.branch_nums] });
      }

      // ---- 期望集拼装（覆盖语义）+ diff ----
      const managers = users.filter((u) => u.position && POSITION_PATTERN.test(u.position));
      const managerUnion = [...new Set(managers.flatMap((m) => perUserBranches.get(m.wecom_id) ?? []))];
      // 白名单：读昨日（最近一行）history.detail.whitelist——人工审批 = 编辑该数组（审计留痕在 detail）
      const { data: recent } = await client.database
        .from('group_reconcile_history')
        .select('whitelist_outside_diff,red_count,detail')
        .order('date', { ascending: false })
        .limit(8);
      const history = (recent ?? []) as unknown as HistoryRow[];
      const whitelist = history[0]?.detail?.whitelist ?? [];

      const diff = classifyMembershipDiff({
        expected: [{ user: COVERAGE_USER, branch_numbers: assessedBranches }],
        actual: [{ user: COVERAGE_USER, branch_numbers: managerUnion }],
        whitelist,
        ignoreExtra: true,   // 覆盖语义：missing（未覆盖）驱动；extra（辖区⊇考核集）良性
      });
      // fail-close 展开失败并入红（保守：无法证明覆盖 → 按未覆盖计）
      for (const e of expandErrors) diff.red.push({ user: e.user, missing: [], extra: [] });

      const today = new Date(Date.now() + 8 * 3600_000).toISOString().split('T')[0]; // 北京时区自然日（getDateOffsetChina 同款）
      const row = buildReconcileRow({ date: today, diff });
      (row.detail as Record<string, unknown>).expandErrors = expandErrors;
      (row.detail as Record<string, unknown>).whitelist = whitelist;              // 当日生效白名单快照（审批留痕）
      (row.detail as Record<string, unknown>).assessedBranchCount = assessedBranches.length;
      (row.detail as Record<string, unknown>).managerCount = managers.length;

      // ---- 落表（date PK 幂等 upsert）----
      const { error: upsertErr } = await client.database
        .from('group_reconcile_history')
        .upsert(row, { onConflict: 'date' });
      if (upsertErr) throw new Error(`写 group_reconcile_history 失败: ${upsertErr.message}`);

      // ---- 7 天门禁状态（最近 7 行含今日）----
      const { data: weekRows } = await client.database
        .from('group_reconcile_history')
        .select('whitelist_outside_diff,red_count')
        .order('date', { ascending: false })
        .limit(7);
      const week = ((weekRows ?? []) as unknown as { whitelist_outside_diff: number; red_count: number }[])
        .map((h) => ({ whitelistOutsideDiff: h.whitelist_outside_diff, redCount: h.red_count }))
        .reverse();
      const gatePass = gate7days(week);

      // ---- 告警（red>0 发 collect_fail 同款企微 ops 告警；collect_logs 有 task_id FK 不落虚拟行，直发 notifyWecom）----
      if (row.red_count > 0 || row.whitelist_outside_diff > 0) {
        const lines = diff.red.slice(0, 10).map((r) =>
          r.user === COVERAGE_USER
            ? `- 考核门店无店长覆盖 ${r.missing.length} 家：${r.missing.slice(0, 5).join('、')}${r.missing.length > 5 ? '…' : ''}`
            : `- ${r.user}: missing=${JSON.stringify(r.missing)} extra=${JSON.stringify(r.extra)}`,
        );
        await notifyWecom(
          '🔴 组对账 E 级红（Task10 H10）',
          `**日期**: ${today}\n**白名单外 diff**: ${row.whitelist_outside_diff}\n**红用户/行**: ${row.red_count}\n${lines.join('\n')}${expandErrors.length ? `\n**展开失败(fail-close)**: ${expandErrors.map((e) => e.user).join('、')}` : ''}`,
        );
      }
      console.log(`[reconcile-groups] ${today}: assessed=${assessedBranches.length} managers=${managers.length} red=${row.red_count} outsideDiff=${row.whitelist_outside_diff} gate7=${gatePass ? 'PASS' : 'OPEN'}`);

      return {
        status: 'ok',
        message: `red=${row.red_count} whitelistOutsideDiff=${row.whitelist_outside_diff} gate7days=${gatePass}`,
        detail: { row, gatePass },
      };
    } finally {
      runningTasks.delete('__reconcile_groups');
    }
  },
};
