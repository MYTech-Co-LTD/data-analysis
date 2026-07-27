import { describe, it, expect } from 'vitest';
import { diffImport } from '../import-diff';

describe('diffImport', () => {
  const current = [
    { branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
    { branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } },
  ];

  it('只返回变更格', () => {
    const incoming = [
      { branch_num: '001', branch_name: 'A店', metrics: { sale: 5500, delivery: 2000 } }, // sale 变
      { branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } }, // 没变
    ];
    const d = diffImport(current, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ branch_num: '001', metric: 'sale', oldValue: 5000, newValue: 5500, diff: 500 });
  });

  it('新增门店（当前无）也算变更', () => {
    const incoming = [
      { branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
      { branch_num: '003', branch_name: 'C店', metrics: { sale: 8000, delivery: 0 } },
    ];
    const d = diffImport(current, incoming);
    expect(d.find(x => x.branch_num === '003' && x.metric === 'sale')).toMatchObject({ oldValue: 0, newValue: 8000 });
  });

  it('空 incoming 返回空数组', () => {
    expect(diffImport(current, [])).toEqual([]);
  });
});
