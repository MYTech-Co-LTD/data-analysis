// web/lib/__tests__/view-groups.test.ts
// Task 19 基线（plan 逐字；唯一 harness 修正：plan 伪代码在非 async 回调里 await import，
// 语法不成立——补 async，断言语义不变，同 179 勘误①先例）。
import { describe, it, expect } from 'vitest';
import { expandViewGroups, validateViewGroupMembers } from '../view-groups';

describe('view-group 展开（spec §5.5，S1/M1）', () => {
  it('组键展开为成员 view:* 键；非组键原样保留', () => {
    const out = expandViewGroups([
      'data-analysis:gate:reports-center', 'data-analysis:admin',
    ]);
    expect(out).toContain('data-analysis:view:reports');
    expect(out).toContain('data-analysis:view:reports-targets');  // 方案 C：成员收敛为保留页面视图
    expect(out).toContain('data-analysis:admin');
    expect(out).not.toContain('data-analysis:gate:reports-center');   // 组键被展开消费
  });

  it('嵌套组递归展开（A 组含 B 组 → B 的成员也出现）', async () => {
    // 用注入 groups 参数测嵌套（catalog 真值只有一层，机制须支持嵌套）
    const groups = {
      'g:a': { label: 'A', members: ['g:b', 'data-analysis:view:reports'] },
      'g:b': { label: 'B', members: ['data-analysis:view:reports-targets'] },  // 方案 C：用保留成员替代退役的 reports-items
    } as never;
    const { expandViewGroups: exp } = await import('../view-groups');
    expect(exp(['g:a'], groups)).toContain('data-analysis:view:reports-targets');
  });

  it('环引用不死循环（visited 截断；准入门在校验器——此处防御性）', async () => {
    const groups = {
      'g:a': { label: 'A', members: ['g:b'] },
      'g:b': { label: 'B', members: ['g:a', 'data-analysis:view:reports'] },
    } as never;
    const { expandViewGroups: exp } = await import('../view-groups');
    const out = exp(['g:a'], groups);
    expect(out).toContain('data-analysis:view:reports');   // 可达成员仍出现
    expect(out.filter((k) => k.startsWith('g:')).length).toBe(0);   // 不挂死、组键全被消费
  });

  it('M1：成员禁含通配/自引用——offenders 报出', () => {
    const bad = {
      'g:x': { label: 'X', members: ['data-analysis:view:*', 'g:x'] },
    } as never;
    expect(validateViewGroupMembers(bad).offenders).toEqual([
      'g:x -> data-analysis:view:*', 'g:x -> g:x',
    ]);
  });

  it('转正接线：resolveViewKey 对组持有者放行成员视图', async () => {
    const { resolveViewKey } = await import('../feature-perm');
    const r = resolveViewKey(['data-analysis:gate:reports-center'], 'reports');
    expect(r.ok).toBe(true);
  });
});
