// web/lib/reconcile-groups.ts
// W2 独立期望源「人→门店」对账（Task 10，spec §5.8 H10 / M4 七天门禁）。
// 这是 scripts/reconcile-groups.mjs（node:test 直测）的 TS 同语义镜像——web 运行时（cron route / job manifest）
// 无法跨包 import 仓库根的 mjs（next build 跨根打包坑，CLAUDE.md/memory 教训），两份实现靠
// web/lib/__tests__/reconcile-groups.test.ts 对照测试（同款断言逐字移植）防漂移。
// 期望源铁律（H10）：期望 = 考核分区/店长岗位清单（dim_war_zone × org_users.position——企微原始字段），
// 禁用 org_departments 投影（它已被 spec 降级为 Group 树投影 = 被测对象，循环自证）。

export interface ExpectedMembership {
  user: string;
  branch_numbers: string[];
}

export interface ActualMembership {
  user: string;
  branch_numbers: string[];
}

export interface WhitelistEntry {
  user: string;
  branch_number: string;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface MembershipDiff {
  red: { user: string; missing: string[]; extra: string[] }[];   // E 级红：白名单外成员级 diff（双向）
  minor: { user: string; kind: string }[];                        // M 级：期望源缺席但挂了组（新员工，提示补录不算红）
  whitelistHits: { user: string; branches: string[] }[];          // 白名单命中（人工审批+审计留痕，单列不算红）
}

export function classifyMembershipDiff({ expected, actual, whitelist }: {
  expected: ExpectedMembership[];
  actual: ActualMembership[];
  whitelist?: WhitelistEntry[];
}): MembershipDiff {
  const red: MembershipDiff['red'] = [];
  const minor: MembershipDiff['minor'] = [];
  const whitelistHits: MembershipDiff['whitelistHits'] = [];
  const wl = new Set((whitelist ?? []).map((w) => `${w.user}:${w.branch_number}`));
  const byUser = new Map(actual.map((a) => [a.user, a.branch_numbers]));
  for (const e of expected) {
    const got = byUser.get(e.user) ?? [];
    const missing = e.branch_numbers.filter((b) => !got.includes(b) && !wl.has(`${e.user}:${b}`));
    const extra = got.filter((b) => !e.branch_numbers.includes(b) && !wl.has(`${e.user}:${b}`));
    const wlHit = e.branch_numbers.filter((b) => !got.includes(b) && wl.has(`${e.user}:${b}`));
    if (missing.length || extra.length) red.push({ user: e.user, missing, extra });
    if (wlHit.length) whitelistHits.push({ user: e.user, branches: wlHit });
  }
  // M 级：期望源缺席的用户挂了组（新员工未进分区清单——提示补录，不算红）
  const expUsers = new Set(expected.map((e) => e.user));
  for (const a of actual) if (!expUsers.has(a.user) && a.branch_numbers.length) minor.push({ user: a.user, kind: 'M-not-in-expected' });
  return { red, minor, whitelistHits };
}

// 7 天门禁（M4，W2 退出判据）：最近 7 行 group_reconcile_history 全部白名单外 diff=0 且红=0 才放行 W3。
export const gate7days = (history: { whitelistOutsideDiff: number; redCount: number }[]): boolean =>
  history.slice(-7).length === 7 &&
  history.slice(-7).every((h) => h.whitelistOutsideDiff === 0 && h.redCount === 0);

// group_reconcile_history 日行构造（date PK；UPSERT 由调用方经 Prefer=resolution=merge-duplicates 承担）。
export function buildReconcileRow({ date, diff }: { date: string; diff: MembershipDiff }) {
  return {
    date,
    whitelist_outside_diff: diff.red.reduce((n, r) => n + r.missing.length + r.extra.length, 0),
    red_count: diff.red.length,
    detail: {
      red: diff.red,
      minor: diff.minor,
      whitelistHits: diff.whitelistHits,
    },
  };
}
