/**
 * 推送引擎核心测试
 *
 * 覆盖：
 * - scope 签名归一化（同义不同序 → 同签名）
 * - 同 scope 收件人分组
 * - 无权限收件人 skipped
 * - 悬空部门检测
 * - selector 解析
 */

import { describe, it, expect } from 'vitest';
import { scopeSignature, scopeEqual, type Scope } from '../scope-signature';
import { resolveRecipients, type Selector, type ResolverDeps } from '../selectors';
import { groupRecipients, type Perms } from '../engine';
import type { Perms as PushPerms } from '../push-variables';

// Perms 新形状 fixture（M4/方案 A：data_scope + fields）
const p = (over: Partial<PushPerms> = {}): Perms => ({
  data_scope: { brands: [], categories: [], branch_nums: [] },
  fields: { cost: false },
  ...over,
});

// ─── scope 签名（M6：基于 data_scope/fields）───

describe('scopeSignature', () => {
  it('同义不同序 → 同签名', () => {
    const a = p({ data_scope: { brands: ['b2', 'b1'], categories: [], branch_nums: [] } });
    const b = p({ data_scope: { brands: ['b1', 'b2'], categories: [], branch_nums: [] } });
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });

  it('空数组 vs 缺段相同（归一化）', () => {
    const a = p();
    const b = p({ data_scope: { brands: [], categories: [], branch_nums: [] } });
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });

  it('fields.cost 参与签名（M6：不同 cost 权限不得同组）', () => {
    const a = p({ fields: { cost: true } });
    const b = p({ fields: { cost: false } });
    expect(scopeSignature(a)).not.toBe(scopeSignature(b));
  });

  it('不同门店集 → 不同签名（M6：防签名碰撞跨用户泄漏）', () => {
    const a = p({ data_scope: { brands: ['3120'], categories: [], branch_nums: ['3120-0001'] } });
    const b = p({ data_scope: { brands: ['3120'], categories: [], branch_nums: ['3120-0002'] } });
    expect(scopeSignature(a)).not.toBe(scopeSignature(b));
  });

  it("['*'] vs 388 明细 → 不同签名（M6：全权与明细各自成组）", () => {
    const a = p({ data_scope: { brands: [], categories: [], branch_nums: ['*'] } });
    const b = p({ data_scope: { brands: [], categories: [], branch_nums: Array.from({ length: 388 }, (_, i) => `3120-${String(i + 1).padStart(4, '0')}`) } });
    expect(scopeSignature(a)).not.toBe(scopeSignature(b));
  });

  it('四维完整签名', () => {
    const scope = p({
      data_scope: { brands: ['3120'], branch_nums: ['*'], categories: ['水果', '标品'] },
      fields: { cost: false },
    });
    const sig = scopeSignature(scope);
    expect(() => JSON.parse(sig)).not.toThrow();
    const parsed = JSON.parse(sig);
    expect(parsed.b).toEqual(['3120']);
    expect(parsed.br).toEqual(['*']);
    expect(parsed.c).toEqual(['标品', '水果']); // 字节序
    expect(parsed.cost).toBe(false);
  });

  it('scopeEqual 等价判断', () => {
    const a = p({ data_scope: { brands: ['a', 'b'], categories: ['x'], branch_nums: [] } });
    const b = p({ data_scope: { brands: ['b', 'a'], categories: ['x'], branch_nums: [] } });
    expect(scopeEqual(a, b)).toBe(true);
  });
});

// ─── 分组 ───

describe('groupRecipients', () => {
  it('同 scope 分到同组', async () => {
    const perms = p({ data_scope: { brands: ['3120'], categories: [], branch_nums: ['*'] } });
    const getPerms = async () => perms;
    const result = await groupRecipients(['u1', 'u2'], getPerms);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].members).toEqual(['u1', 'u2']);
    expect(result.skipped).toHaveLength(0);
  });

  it('无权限用户 → skipped', async () => {
    const getPerms = async () => null;
    const result = await groupRecipients(['u1'], getPerms);
    expect(result.groups).toHaveLength(0);
    expect(result.skipped).toEqual(['u1']);
  });

  it('不同 scope 分到不同组', async () => {
    const getPerms = async (id: string) =>
      id === 'u1'
        ? p({ data_scope: { brands: ['3120'], categories: [], branch_nums: ['*'] } })
        : p({ data_scope: { brands: ['64188'], categories: [], branch_nums: ['*'] } });
    const result = await groupRecipients(['u1', 'u2'], getPerms);
    expect(result.groups).toHaveLength(2);
  });
});

// ─── selector ───

describe('resolveRecipients', () => {
  const mockDeps: ResolverDeps = {
    getUserById: async (id) =>
      id === 'u1'
        ? { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10 }
        : null,
    getUsersByDept: async (deptId) =>
      deptId === 10
        ? [
            { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10 },
            { id: 'u2', wecom_id: 'wx2', is_active: true, dept_id: 10 },
          ]
        : [],
    getUsersByRole: async (roleId) =>
      roleId === 5
        ? [{ id: 'u3', wecom_id: 'wx3', is_active: true, role_id: 5 }]
        : [],
    getAllActiveUsers: async () => [
      { id: 'u1', wecom_id: 'wx1', is_active: true },
      { id: 'u2', wecom_id: 'wx2', is_active: true },
    ],
  };

  it('person selector', async () => {
    const result = await resolveRecipients(
      { kind: 'person', ids: ['u1', 'nonexistent'] },
      mockDeps
    );
    expect(result.recipients).toEqual(['wx1']);
  });

  it('dept selector + 悬空部门', async () => {
    const result = await resolveRecipients(
      { kind: 'dept', ids: ['10', '99'] },
      mockDeps
    );
    expect(result.recipients).toContain('wx1');
    expect(result.recipients).toContain('wx2');
    expect(result.danglingDepts).toEqual([99]); // 部门99无活跃用户
  });

  it('role selector', async () => {
    const result = await resolveRecipients(
      { kind: 'role', ids: ['5'] },
      mockDeps
    );
    expect(result.recipients).toEqual(['wx3']);
  });

  it('all selector', async () => {
    const result = await resolveRecipients({ kind: 'all' }, mockDeps);
    expect(result.recipients).toEqual(['wx1', 'wx2']);
  });

  it('去重：同一用户在多个部门', async () => {
    const deps: ResolverDeps = {
      ...mockDeps,
      getUsersByDept: async () => [
        { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10 },
        { id: 'u1', wecom_id: 'wx1', is_active: true, dept_id: 10 },
      ],
    };
    const result = await resolveRecipients(
      { kind: 'dept', ids: ['10'] },
      deps
    );
    expect(result.recipients).toEqual(['wx1']);
  });

  it('不活跃用户被过滤', async () => {
    const deps: ResolverDeps = {
      ...mockDeps,
      getUserById: async () => ({
        id: 'u1',
        wecom_id: 'wx1',
        is_active: false,
      }),
    };
    const result = await resolveRecipients(
      { kind: 'person', ids: ['u1'] },
      deps
    );
    expect(result.recipients).toEqual([]);
  });
});
