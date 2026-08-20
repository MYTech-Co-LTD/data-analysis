// web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts
import { describe, it, expect } from 'vitest';
import { matchesDate, isTimeReached, nextRunLabel } from '../cron-match';

describe('matchesDate', () => {
  it('daily：每天 due', () => {
    expect(matchesDate({ kind: 'daily', time: '08:30' }, new Date('2026-08-20'))).toBe(true);
    expect(matchesDate({ kind: 'daily', time: '08:30' }, new Date('2026-08-21'))).toBe(true);
  });
  it('weekly：仅指定周几 due（周一=1）', () => {
    // 2026-08-21 是周五（weekday=5）
    expect(matchesDate({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-21'))).toBe(true);
    expect(matchesDate({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-20'))).toBe(false);
  });
  it('monthly：仅指定日 due；当月无该日则全月不 due（2月无31）', () => {
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-01'))).toBe(true);
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-15'))).toBe(false);
    // 2026-02 无 31 日
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 31 }, new Date('2026-02-10'))).toBe(false);
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 31 }, new Date('2026-01-31'))).toBe(true);
  });
});

describe('isTimeReached（终审 C2：time 参与调度判定）', () => {
  it('daily 08:30：00:00 未到（不触发）、09:00 已过（当日补发触发）', () => {
    const spec = { kind: 'daily', time: '08:30' } as const;
    expect(isTimeReached(spec, new Date('2026-08-20T00:00:00'))).toBe(false);
    expect(isTimeReached(spec, new Date('2026-08-20T09:00:00'))).toBe(true);
  });
  it('边界：恰好等于配置时刻 → 已到（>=）', () => {
    const spec = { kind: 'daily', time: '08:30' } as const;
    expect(isTimeReached(spec, new Date('2026-08-20T08:30:00'))).toBe(true);
  });
  it('weekly/monthly：isTimeReached 与 kind/日期无关（组合 AND 在 manifest：日期不 due 即使 time 到也不触发）', () => {
    // 2026-08-20 是周四，非周一——matchesDate=false；但 time 到 → isTimeReached=true（组合时由 manifest AND 掉）
    const weekly = { kind: 'weekly', time: '17:00', weekday: 1 } as const;
    expect(isTimeReached(weekly, new Date('2026-08-20T18:00:00'))).toBe(true);
    expect(matchesDate(weekly, new Date('2026-08-20T18:00:00'))).toBe(false);
    // 08-20 非 1 日——matchesDate=false；time 到 → isTimeReached=true
    const monthly = { kind: 'monthly', time: '09:00', day: 1 } as const;
    expect(isTimeReached(monthly, new Date('2026-08-20T10:00:00'))).toBe(true);
    expect(matchesDate(monthly, new Date('2026-08-20T10:00:00'))).toBe(false);
  });
  it('畸形/越界 time → 不阻塞（isTimeReached true）；创建侧正则拒绝（route 校验）', () => {
    // 9:5：分钟 1 位 → 不匹配；99:99：时/分越界 → 不匹配。均视为无时间约束
    expect(isTimeReached({ kind: 'daily', time: '9:5' }, new Date('2026-08-20T00:00:00'))).toBe(true);
    expect(isTimeReached({ kind: 'daily', time: '99:99' }, new Date('2026-08-20T00:00:00'))).toBe(true);
  });
  it('单位数小时（8:30）容忍兼容：正常计算', () => {
    const spec = { kind: 'daily', time: '8:30' } as const;
    expect(isTimeReached(spec, new Date('2026-08-20T00:00:00'))).toBe(false);
    expect(isTimeReached(spec, new Date('2026-08-20T09:00:00'))).toBe(true);
  });
});

describe('nextRunLabel', () => {
  it('各 kind 输出通俗中文', () => {
    expect(nextRunLabel({ kind: 'daily', time: '08:30' }, new Date('2026-08-20'))).toBe('每天 08:30');
    expect(nextRunLabel({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-20'))).toBe('每周五 17:00');
    expect(nextRunLabel({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-20'))).toBe('每月1日 09:00');
  });
});
