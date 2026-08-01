import { describe, it, expect } from 'vitest';
import { astToSql, renderFormula, A, type AstCtx } from '../src/ast';

const ctx = (refs: Record<string, string>, useTargetWindow = true): AstCtx => ({
  cteOf: new Map(Object.entries(refs)),
  useTargetWindow,
});

describe('astToSql', () => {
  it('ref: 已知 metric -> cteN.code', () => {
    expect(astToSql(A.ref('sale_amount'), ctx({ sale_amount: 'cte0' }))).toBe('cte0.sale_amount');
  });

  it('ref: 窗口列 -> tgt.col（target_window 开）', () => {
    expect(astToSql(A.ref('total_days'), ctx({}, true))).toBe('tgt.total_days');
  });

  it('ref: 窗口列无 target_window -> 裸标识符', () => {
    expect(astToSql(A.ref('latest_day'), ctx({}, false))).toBe('latest_day');
  });

  it('ref: 未知 metric 且非窗口列 -> throw（防 formula 引用不存在 metric）', () => {
    expect(() => astToSql(A.ref('nonexistent'), ctx({}, true))).toThrow(/非已知 metric CTE 也非窗口列/);
  });

  it('lit: 数字字面量', () => {
    expect(astToSql(A.lit(0), ctx({}))).toBe('0');
  });

  it('op: + - / * 加括号', () => {
    const c = ctx({ sale_amount: 'a', sale_target: 'b' });
    expect(astToSql(A.op('+', A.ref('sale_amount'), A.ref('sale_target')), c)).toBe('(a.sale_amount + b.sale_target)');
    expect(astToSql(A.op('/', A.ref('sale_amount'), A.ref('sale_target')), c)).toBe('(a.sale_amount / b.sale_target)');
  });

  it('call: nullif/greatest', () => {
    const c = ctx({}, true);  // 窗口列走 tgt. 前缀
    const expr = A.call('nullif', A.op('-', A.ref('total_days'), A.ref('days_elapsed')), A.lit(0));
    expect(astToSql(expr, c)).toBe('nullif((tgt.total_days - tgt.days_elapsed), 0)');
  });

  it('filter: X FILTER (WHERE col = val)', () => {
    const c = ctx({ sale_amount: 'cte0' }, true);
    const expr = A.filter(A.ref('sale_amount'), 'biz_date', A.ref('latest_day'));
    expect(astToSql(expr, c)).toBe('cte0.sale_amount FILTER (WHERE biz_date = tgt.latest_day)');
  });

  it('组合：remaining_daily_sale = (T-A)/greatest(total_days-days_elapsed, 1)', () => {
    const c = ctx({ sale_target: 'cte0', sale_amount: 'cte1' }, true);
    const ast = A.op(
      '/',
      A.op('-', A.ref('sale_target'), A.ref('sale_amount')),
      A.call('greatest', A.op('-', A.ref('total_days'), A.ref('days_elapsed')), A.lit(1)),
    );
    expect(astToSql(ast, c)).toBe('((cte0.sale_target - cte1.sale_amount) / greatest((tgt.total_days - tgt.days_elapsed), 1))');
  });

  it('组合：rate = sale_amount / sale_target', () => {
    const c = ctx({ sale_amount: 'cte0', sale_target: 'cte1' });
    expect(astToSql(A.op('/', A.ref('sale_amount'), A.ref('sale_target')), c))
      .toBe('(cte0.sale_amount / cte1.sale_target)');
  });

  it('组合：additive = delivery_amount + wholesale_pp_amount', () => {
    const c = ctx({ delivery_amount: 'cte0', wholesale_pp_amount: 'cte1' });
    expect(astToSql(A.op('+', A.ref('delivery_amount'), A.ref('wholesale_pp_amount')), c))
      .toBe('(cte0.delivery_amount + cte1.wholesale_pp_amount)');
  });
});

describe('renderFormula', () => {
  it('人读串不暴露 CTE 别名（纯口径）', () => {
    const ast = A.op('/', A.ref('sale_amount'), A.ref('sale_target'));
    expect(renderFormula(ast)).toBe('(sale_amount / sale_target)');
  });
  it('remaining 人读串', () => {
    const ast = A.op(
      '/',
      A.op('-', A.ref('sale_target'), A.ref('sale_amount')),
      A.call('greatest', A.op('-', A.ref('total_days'), A.ref('days_elapsed')), A.lit(1)),
    );
    expect(renderFormula(ast)).toBe('((sale_target - sale_amount) / greatest((total_days - days_elapsed), 1))');
  });
});
