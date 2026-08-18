// web/lib/__tests__/exception-claims.test.ts 兼 catalog_v 用例（同文件两组 describe）
import { describe, it, expect } from 'vitest';
import { catalogVCheck, resolveViewKey } from '../feature-perm';

describe('catalog_v 快/慢路径（spec §5.4，M3.5 防全员锁死）', () => {
  it('版本戳相等 → 快路径（跳过逐 key 校验，即使 claims 含已下架 key）', () => {
    const r = catalogVCheck({ catalog_v: '20260816.1', permissions: ['data-analysis:view:gone'] }, '20260816.1');
    expect(r).toEqual({ fastPath: true, rejected: [] });
  });
  it('版本戳不等 → 慢路径：每 key ∈ catalog∪deprecated，已驱逐 key 进 rejected；其余照常（非全拒）', () => {
    const r = catalogVCheck({ catalog_v: '20260816.0', permissions: ['data-analysis:admin', 'data-analysis:view:gone'] }, '20260816.1');
    expect(r.fastPath).toBe(false);
    expect(r.rejected).toEqual(['data-analysis:view:gone']);   // 只拒该 key，admin 照常（H6 key 级）
  });
  it('catalog_v 缺失（旧形状令牌）→ 慢路径 + stale 标记（≤48h TTL 由调用方按 iat 判）', () => {
    const r = catalogVCheck({ permissions: ['data-analysis:admin'] }, '20260816.1');
    expect(r.fastPath).toBe(false);
    expect(r.rejected).toEqual([]);
  });
});

describe('解析期校验（M2：通配持有者对已驱逐 key 不可用）', () => {
  it('2026-08-18 方案 A：reports 视图已删 → 具名也不放行（unknown）', () => {
    expect(resolveViewKey(['data-analysis:view:reports'], 'reports')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('通配命中但具体 key 已被驱逐（不在 catalog∪deprecated）→ fail-close（M2 攻击路径封口）', () => {
    expect(resolveViewKey(['data-analysis:view:*'], 'gone')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('通配命中且 key 在 deprecated → 拒（deprecated = 拒绝+告警，非放行）', () => {
    const r = resolveViewKey(['data-analysis:view:*'], 'reports-items');
    expect(r).toEqual({ ok: false, reason: 'deprecated' });
  });
});
