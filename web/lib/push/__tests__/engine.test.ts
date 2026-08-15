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

// ─── scope 签名 ───

describe('scopeSignature', () => {
  it('同义不同序 → 同签名', () => {
    const a: Scope = { brands: ['b2', 'b1'] };
    const b: Scope = { brands: ['b1', 'b2'] };
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });

  it('空数组 vs undefined 相同（归一化）', () => {
    const a: Scope = { brands: [] };
    const b: Scope = {};
    expect(scopeSignature(a)).toBe(scopeSignature(b));
  });

  it('can_see_cost 参与签名', () => {
    const a: Scope = { can_see_cost: true };
    const b: Scope = { can_see_cost: false };
    expect(scopeSignature(a)).not.toBe(scopeSignature(b));
  });

  it('四维完整签名', () => {
    const scope: Scope = {
      brands: ['3120'],
      branch_nums: ['*'],
      categories: ['水果', '标品'],
      can_see_cost: false,
    };
    const sig = scopeSignature(scope);
    // 应该是有效 JSON
    expect(() => JSON.parse(sig)).not.toThrow();
    const parsed = JSON.parse(sig);
    expect(parsed.b).toEqual(['3120']);
    expect(parsed.br).toEqual(['*']);
    expect(parsed.c).toEqual(['标品', '水果']); // 字节序
    expect(parsed.cost).toBe(false);
  });

  it('scopeEqual 等价判断', () => {
    const a: Scope = { brands: ['a', 'b'], categories: ['x'] };
    const b: Scope = { brands: ['b', 'a'], categories: ['x'] };
    expect(scopeEqual(a, b)).toBe(true);
  });
});

// ─── 分组 ───

describe('groupRecipients', () => {
  it('同 scope 分到同组', async () => {
    const perms: Perms = { brands: ['3120'] };
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
      id === 'u1' ? { brands: ['3120'] } : { brands: ['64188'] };
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
    expect(result.recipients).toEqual(['u1']);
  });

  it('dept selector + 悬空部门', async () => {
    const result = await resolveRecipients(
      { kind: 'dept', ids: ['10', '99'] },
      mockDeps
    );
    expect(result.recipients).toContain('u1');
    expect(result.recipients).toContain('u2');
    expect(result.danglingDepts).toEqual([99]); // 部门99无活跃用户
  });

  it('role selector', async () => {
    const result = await resolveRecipients(
      { kind: 'role', ids: ['5'] },
      mockDeps
    );
    expect(result.recipients).toEqual(['u3']);
  });

  it('all selector', async () => {
    const result = await resolveRecipients({ kind: 'all' }, mockDeps);
    expect(result.recipients).toEqual(['u1', 'u2']);
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
    expect(result.recipients).toEqual(['u1']);
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
