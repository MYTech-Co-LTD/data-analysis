// web/lib/sync/__tests__/role-scope.test.ts
// 角色链资源解析契约测试（2026-08-18 三层模型强制）：
//   matchRolePermissions 断言与 functions/wecom-oidc-callback/claims.test.js 同语义（防 function/web 侧口径漂移）；
//   normalizeFriendlyPerm 用**真实 catalog** round-trip（capability-catalog 单真相：每个 catalog key 的展示名
//   normalize 回 key），防与 claims.js FRIENDLY_TO_KEY 静态表漂移。纯函数，无 mock。
import { describe, it, expect } from 'vitest';
import { matchRolePermissions, normalizeFriendlyPerm } from '../role-scope';
import { capabilityCatalog, displayNameFor, DISPLAY_NAME_TO_KEY } from '../../capability-catalog';

// Casdoor permission 真实形态：roles=全路径数组；直挂用户存 users（本函数不读）；groups 挂载存 groups（本函数不读）
const permsRole = [
  { name: 'role-manager', roles: ['shanhai/manager'], users: [], resources: ['data-analysis:view:reports', 'push:broadcast'] },
  { name: 'role-boss', roles: ['shanhai/boss'], users: [], resources: ['data-analysis:admin'] },
];
const permsDirect = [
  { name: 'scope-张三', roles: [], users: ['shanhai/张三'], resources: ['data-analysis:branch:*'] },
];
const permsMixed = [
  { name: 'role-zone', roles: ['shanhai/zone_manager'], users: ['shanhai/郑欣'], resources: ['data-analysis:view-board:region'] },
];
const permsDup = [
  { name: 'role-a', roles: ['shanhai/manager'], users: [], resources: ['data-analysis:view:reports', 'push:broadcast'] },
  { name: 'role-b', roles: ['shanhai/manager'], users: [], resources: ['data-analysis:view:reports', 'data-analysis:admin'] },
];
const permsNum = [
  { name: 'role-num', roles: ['shanhai/12345'], users: [], resources: ['push:broadcast'] },
];

describe('matchRolePermissions（三层模型强制，与 claims.test.js 同语义）', () => {
  it('角色命中（用户裸名 vs 权限全路径）→ resources 并集', () => {
    expect(matchRolePermissions(permsRole, ['manager'])).toEqual(['data-analysis:view:reports', 'push:broadcast']);
  });
  it('只取命中角色的 permission', () => {
    expect(matchRolePermissions(permsRole, ['boss'])).toEqual(['data-analysis:admin']);
  });
  it('直挂（roles=[]）被排除——三层模型强制', () => {
    expect(matchRolePermissions([...permsRole, ...permsDirect], ['manager']))
      .toEqual(['data-analysis:view:reports', 'push:broadcast']);
  });
  it('多角色 UNION；混合形态角色命中即取全部 resources', () => {
    expect(matchRolePermissions([...permsRole, ...permsMixed], ['manager', 'zone_manager']))
      .toEqual(['data-analysis:view:reports', 'push:broadcast', 'data-analysis:view-board:region']);
  });
  it('只命中一个角色的资源', () => {
    expect(matchRolePermissions([...permsRole, ...permsMixed], ['zone_manager']))
      .toEqual(['data-analysis:view-board:region']);
  });
  it('用户角色码存在但权限全是直挂 → 空集（B1 deny 载体）', () => {
    expect(matchRolePermissions(permsDirect, ['张三'])).toEqual([]);
  });
  it('全量空 → 空数组', () => {
    expect(matchRolePermissions([], ['manager'])).toEqual([]);
  });
  it('无角色 → 空数组（无角色即无授权）', () => {
    expect(matchRolePermissions(permsRole, [])).toEqual([]);
  });
  it('undefined 入参防御 → 空数组', () => {
    expect(matchRolePermissions(undefined, ['manager'])).toEqual([]);
    expect(matchRolePermissions(permsRole, undefined)).toEqual([]);
  });
  it('跨 permission 命中同角色 → resources 并集去重', () => {
    expect(matchRolePermissions(permsDup, ['manager']))
      .toEqual(['data-analysis:view:reports', 'push:broadcast', 'data-analysis:admin']);
  });
  it('数字角色码 String 归一命中', () => {
    expect(matchRolePermissions(permsNum, [12345])).toEqual(['push:broadcast']);
  });
});

describe('normalizeFriendlyPerm（catalog 单真相 round-trip）', () => {
  it('真实 CATALOG round-trip：每个 catalog key 的展示名 normalize 回原 key', () => {
    expect(capabilityCatalog.length).toBeGreaterThan(0);
    for (const e of capabilityCatalog) {
      const display = displayNameFor(e.key);
      expect(normalizeFriendlyPerm(display)).toBe(e.key);
    }
  });
  it('DISPLAY_NAME_TO_KEY 反查精确：catalog 展示名唯一（构建期已断言），round-trip 逐项成立', () => {
    for (const [display, key] of DISPLAY_NAME_TO_KEY) {
      expect(normalizeFriendlyPerm(display)).toBe(key);
    }
  });
  it('范围|X 前缀规则 → data-analysis:branch:X（门店范围显式授权，388 店清单不进 catalog）', () => {
    expect(normalizeFriendlyPerm('范围|中部一区')).toBe('data-analysis:branch:中部一区');
    expect(normalizeFriendlyPerm('范围|*')).toBe('data-analysis:branch:*');
    expect(normalizeFriendlyPerm('范围|全店')).toBe('data-analysis:branch:全店');
  });
  it('未知展示名原样透传（消费侧保守，不误伤）', () => {
    expect(normalizeFriendlyPerm('不存在|的东西')).toBe('不存在|的东西');
  });
  it('已归一 key 原样透传（normalizeFriendlyPerm 同时接受两种形态，preview 同口径提取）', () => {
    expect(normalizeFriendlyPerm('data-analysis:view:reports')).toBe('data-analysis:view:reports');
    expect(normalizeFriendlyPerm('data-analysis:branch:中部一区')).toBe('data-analysis:branch:中部一区');
  });
});
