// web/lib/jobs/collect/__tests__/reconcile-trailing-days.test.ts
// reconcileTrailingDays 盲区回归测试（2026-08-26 配送数据延迟被 `api<=0 continue` 静默跳过）
// 场景：源数据延迟生成（某天 API count=0 但库有数据）→ 记 delayed（告警待补采，不 full 避免清空）；
//        API 恢复后（api>0 且 lib!=api）→ mismatch → full 补采；真无数据（api=0 且库 0）→ 跳过。
import { describe, it, expect, vi } from 'vitest';
import { reconcileTrailingDays } from '../manifest';

describe('reconcileTrailingDays', () => {
  // 构造"今天"固定的调用：reconcileTrailingDays(N=3) 检查最近 3 天（昨天/前天/大前天）
  const DAYS = ['2026-08-26', '2026-08-25', '2026-08-24']; // 从近到远

  it('api=0 但库有数据（数据延迟）→ delayed，不 full（不误清空）', async () => {
    const api = vi.fn(async () => 0); // 所有天 API 都 0（数据延迟）
    const lib = vi.fn(async () => 733); // 库里有 733 行
    const rc = await reconcileTrailingDays(3, api, lib);
    expect(rc.mismatch).toBeUndefined();      // 不触发 full
    expect(rc.delayed).toEqual([DAYS[0], DAYS[1], DAYS[2]]); // 记录延迟天
  });

  it('API 恢复后（api>0 且 lib!=api）→ mismatch → full 补采', async () => {
    const api = vi.fn(async () => 343331);
    const lib = vi.fn(async () => 733);
    const rc = await reconcileTrailingDays(3, api, lib);
    expect(rc.mismatch).toBe(DAYS[0]); // 昨天不匹配 → full
    expect(rc.delayed).toBeUndefined();
  });

  it('真无数据（api=0 且库 0，节假日）→ 跳过，无 mismatch 无 delayed', async () => {
    const api = vi.fn(async () => 0);
    const lib = vi.fn(async () => 0);
    const rc = await reconcileTrailingDays(3, api, lib);
    expect(rc.mismatch).toBeUndefined();
    expect(rc.delayed).toBeUndefined();
  });

  it('全部匹配（api==lib）→ 空结果（incremental）', async () => {
    const api = vi.fn(async () => 100);
    const lib = vi.fn(async () => 100);
    const rc = await reconcileTrailingDays(3, api, lib);
    expect(rc).toEqual({});
  });

  it('某天 api=0 且库 0（真无数据），另一天 mismatch → 返回 mismatch', async () => {
    let call = 0;
    const api = vi.fn(async () => { call++; return call === 1 ? 0 : 500; }); // 昨天 api=0，前天 500
    const lib = vi.fn(async () => { return call === 1 ? 0 : 300; });          // 昨天 lib=0（真无数据），前天 300 != 500
    const rc = await reconcileTrailingDays(3, api, lib);
    expect(rc.mismatch).toBe(DAYS[1]); // 前天 mismatch
    expect(rc.delayed).toBeUndefined();
  });
});
