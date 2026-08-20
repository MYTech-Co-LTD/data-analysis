// web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts
import { describe, it, expect } from 'vitest';
import { matchesDate, nextRunLabel } from '../cron-match';

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

describe('nextRunLabel', () => {
  it('各 kind 输出通俗中文', () => {
    expect(nextRunLabel({ kind: 'daily', time: '08:30' }, new Date('2026-08-20'))).toBe('每天 08:30');
    expect(nextRunLabel({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-20'))).toBe('每周五 17:00');
    expect(nextRunLabel({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-20'))).toBe('每月1日 09:00');
  });
});
