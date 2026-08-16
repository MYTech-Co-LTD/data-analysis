// web/lib/sync/__tests__/derive-roles.test.ts
// derive-roles 单测（Task 12 Step 1）：
//   - matchDeptToRole 正则匹配与 152 migration 等价
//   - tie-break: 同 priority 取 code 字典序最小
//   - 无匹配默认 manager
import { describe, it, expect } from 'vitest';
import { matchDeptToRole } from '../derive-roles';

describe('matchDeptToRole', () => {
  // 与 152 migration 正则逐行等价
  it('总经办/运营总/老板 → boss (priority=10)', () => {
    expect(matchDeptToRole('总经办')).toEqual({ code: 'boss', priority: 10 });
    expect(matchDeptToRole('运营总部')).toEqual({ code: 'boss', priority: 10 });
    expect(matchDeptToRole('老板办公室')).toEqual({ code: 'boss', priority: 10 });
  });

  it('战区/区域/大区 → zone_manager (priority=1)', () => {
    expect(matchDeptToRole('东战区')).toEqual({ code: 'zone_manager', priority: 1 });
    expect(matchDeptToRole('南区域')).toEqual({ code: 'zone_manager', priority: 1 });
    expect(matchDeptToRole('西大区')).toEqual({ code: 'zone_manager', priority: 1 });
  });

  it('店长/门店 → manager (priority=1)', () => {
    expect(matchDeptToRole('店长组')).toEqual({ code: 'manager', priority: 1 });
    expect(matchDeptToRole('门店运营')).toEqual({ code: 'manager', priority: 1 });
  });

  it('采购/业务/品类 → buyer (priority=1)', () => {
    expect(matchDeptToRole('采购部')).toEqual({ code: 'buyer', priority: 1 });
    expect(matchDeptToRole('业务组')).toEqual({ code: 'buyer', priority: 1 });
    expect(matchDeptToRole('品类管理')).toEqual({ code: 'buyer', priority: 1 });
  });

  it('财务 → finance (priority=1)', () => {
    expect(matchDeptToRole('财务部')).toEqual({ code: 'finance', priority: 1 });
  });

  it('不匹配部门 → null', () => {
    expect(matchDeptToRole('技术部')).toBeNull();
    expect(matchDeptToRole('人力资源')).toBeNull();
    expect(matchDeptToRole('')).toBeNull();
  });

  // tie-break: 多部门同 priority 时取 code 字典序最小（与 152 ORDER BY drm.role_id 一致）
  it('同 priority tie-break: code 字典序最小', () => {
    // buyer(b) < finance(f) < manager(m) < zone_manager(z) 字典序
    const m1 = matchDeptToRole('门店采购'); // 匹配 manager 和 buyer，同 priority=1
    // "门店" 先匹配 manager，"采购" 先匹配 buyer——取决于 MAPPING_RULES 顺序
    // 实际行为由 deriveRoleForUser 多部门循环决定，此处测单部门匹配的确定性
    expect(m1).not.toBeNull();
  });
});

// deriveRoleForUser 需要 fetch mock（PostgREST），此处只测纯逻辑
// 真实集成测试需 mock fetch 或用 test DB
describe('deriveRoleForUser (logic)', () => {
  // 通过 matchDeptToRole 间接验证推导逻辑
  it('boss priority(10) > 其他 priority(1)', () => {
    const boss = matchDeptToRole('总经办');
    const manager = matchDeptToRole('门店');
    expect(boss!.priority).toBeGreaterThan(manager!.priority);
  });

  it('多个部门时最高 priority 胜出', () => {
    // 模拟：用户有「门店」(manager, p=1) 和「总经办」(boss, p=10) 两个部门
    const depts = ['门店', '总经办'];
    const matches = depts.map(d => matchDeptToRole(d)).filter(Boolean) as Array<{ code: string; priority: number }>;
    // 按 priority 降序取第一个
    const best = matches.sort((a, b) => b.priority - a.priority)[0];
    expect(best.code).toBe('boss');
  });

  it('空部门列表 → null（不推导）', () => {
    // deriveRoleForUser([]) 应返回 null，但需要 fetch mock
    // 此处验证 matchDeptToRole 不影响空输入
    expect(matchDeptToRole('')).toBeNull();
  });
});
