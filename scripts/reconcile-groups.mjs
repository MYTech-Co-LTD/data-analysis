// scripts/reconcile-groups.mjs
// W2 独立期望源对账（spec §5.8 H10）：期望 = 考核分区/岗位清单（取自 dim_war_zone 数据），
// 非 org_departments 投影（那是被测对象，循环自证）。per-user 成员级 diff + C/E/M 分级。
// 7 天门禁：白名单外 diff=0 连续 ≥7 天才放行 W3（M4）。
// 纯函数模块（无 IO）——数据拉取/落表在 cron 路由（web/app/api/admin/cron/reconcile-groups/route.ts）；
// web 侧同语义 TS 镜像在 web/lib/reconcile-groups.ts（vitest 对照测试防两份漂移）。
export function classifyMembershipDiff({ expected, actual, whitelist }) {
  const red = [], minor = [], whitelistHits = [];
  const wl = new Set((whitelist ?? []).map((w) => `${w.user}:${w.branch_number}`));
  const byUser = new Map(actual.map((a) => [a.user, a.branch_numbers]));
  for (const e of expected) {
    const got = byUser.get(e.user) ?? [];
    const missing = e.branch_numbers.filter((b) => !got.includes(b) && !wl.has(`${e.user}:${b}`));
    const extra   = got.filter((b) => !e.branch_numbers.includes(b) && !wl.has(`${e.user}:${b}`));
    const wlHit   = e.branch_numbers.filter((b) => !got.includes(b) && wl.has(`${e.user}:${b}`));
    if (missing.length || extra.length) red.push({ user: e.user, missing, extra });
    if (wlHit.length) whitelistHits.push({ user: e.user, branches: wlHit });
  }
  // M 级：期望源缺席的用户挂了组（新员工未进分区清单——提示补录，不算红）
  const expUsers = new Set(expected.map((e) => e.user));
  for (const a of actual) if (!expUsers.has(a.user) && a.branch_numbers.length) minor.push({ user: a.user, kind: 'M-not-in-expected' });
  return { red, minor, whitelistHits };
}
export const gate7days = (history) =>
  history.slice(-7).length === 7 &&
  history.slice(-7).every((h) => h.whitelistOutsideDiff === 0 && h.redCount === 0);

// group_reconcile_history 日行构造（date PK，幂等 UPSERT 由 cron 侧 Prefer=resolution=merge-duplicates 承担）。
// whitelistOutsideDiff = 白名单外 diff 数（red 内 missing+extra 未被白名单吸收的条数——classifyMembershipDiff
// 的 red 已剔除白名单命中，故 = Σ(missing+extra)；whitelistHits 单列为审计留痕，不计入门禁）。
export function buildReconcileRow({ date, diff }) {
  const redCount = diff.red.length;
  const whitelistOutsideDiff = diff.red.reduce((n, r) => n + r.missing.length + r.extra.length, 0);
  return {
    date,
    whitelist_outside_diff: whitelistOutsideDiff,
    red_count: redCount,
    detail: {
      red: diff.red,
      minor: diff.minor,
      whitelistHits: diff.whitelistHits,
    },
  };
}
