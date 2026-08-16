// web/lib/__tests__/reconcile-groups.test.ts
// TS 镜像 vs scripts/reconcile-groups.mjs（node:test 4 例）的对照测试——断言逐字移植 plan L1032-1073，
// 两份实现任一漂移在此显形（web 运行时消费 TS 版，node 侧 mjs 版是 plan 验收基线）。
import { describe, it, expect } from 'vitest';
import { classifyMembershipDiff, gate7days, buildReconcileRow } from '../reconcile-groups';

describe('独立期望源成员级对账（Task 10，spec §5.8 H10/M4）——TS 镜像对照', () => {
  it('成员级 diff：用户在期望源有店 A 但挂组展开无 A → E 级红（per-user 粒度）', () => {
    const d = classifyMembershipDiff({
      expected: [{ user: 'zhangsan', branch_numbers: ['3120-001', '3120-002'] }],
      actual: [{ user: 'zhangsan', branch_numbers: ['3120-001'] }],
      whitelist: [],
    });
    expect(d.red.length).toBe(1);
    expect(d.red[0].user).toBe('zhangsan');
    expect(d.red[0].missing[0]).toBe('3120-002');
  });

  it('白名单条目豁免（人工审批挂组）：diff 命中白名单 → 不算红、单列 whitelistHits', () => {
    const d = classifyMembershipDiff({
      expected: [{ user: 'lisi', branch_numbers: ['3120-005'] }],
      actual: [{ user: 'lisi', branch_numbers: [] }],
      whitelist: [{ user: 'lisi', branch_number: '3120-005', reason: '督导跨区', approvedBy: 'boss', approvedAt: '2026-08-20' }],
    });
    expect(d.red.length).toBe(0);
    expect(d.whitelistHits.length).toBe(1);
  });

  it('多挂（实际比期望多店）→ E 级红（越权方向）', () => {
    const d = classifyMembershipDiff({
      expected: [{ user: 'wang', branch_numbers: ['3120-001'] }],
      actual: [{ user: 'wang', branch_numbers: ['3120-001', '64188-001'] }],
      whitelist: [],
    });
    expect(d.red[0].extra[0]).toBe('64188-001');
  });

  it('7 天门禁判定：连续 7 天白名单外 diff=0 才 pass', () => {
    expect(gate7days(Array.from({ length: 7 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 })))).toBe(true);
    expect(gate7days([
      ...Array.from({ length: 7 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 })),
      { whitelistOutsideDiff: 2, redCount: 1 },
    ])).toBe(false);   // 坏日在窗口内 → 门禁关
    expect(gate7days(Array.from({ length: 6 }, () => ({ whitelistOutsideDiff: 0, redCount: 0 })))).toBe(false); // 不足 7 天 → 门禁关
  });

  it('buildReconcileRow：red 汇总 whitelist_outside_diff / red_count，detail 留全量审计', () => {
    const row = buildReconcileRow({
      date: '2026-08-16',
      diff: classifyMembershipDiff({
        expected: [
          { user: 'a', branch_numbers: ['3120-001', '3120-002'] },
          { user: 'b', branch_numbers: ['3120-003'] },
        ],
        actual: [
          { user: 'a', branch_numbers: ['3120-001'] },               // missing 1
          { user: 'b', branch_numbers: ['3120-003', '64188-001'] },  // extra 1
          { user: 'c', branch_numbers: ['3120-009'] },               // M 级（不在期望源）
        ],
        whitelist: [],
      }),
    });
    expect(row.date).toBe('2026-08-16');
    expect(row.whitelist_outside_diff).toBe(2);   // 1 missing + 1 extra
    expect(row.red_count).toBe(2);
    expect(row.detail.minor).toEqual([{ user: 'c', kind: 'M-not-in-expected' }]);
    expect(row.detail.whitelistHits).toEqual([]);
  });
});
