import { describe, it, expect } from 'vitest';
import { diffImport } from '../import-diff';

describe('diffImport', () => {
  const current = [
    { branch_number: 'sbc1-001', system_book_code: 'sbc1', branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
    { branch_number: 'sbc1-002', system_book_code: 'sbc1', branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } },
  ];

  it('只返回变更格', () => {
    const incoming = [
      { branch_number: 'sbc1-001', system_book_code: 'sbc1', branch_num: '001', branch_name: 'A店', metrics: { sale: 5500, delivery: 2000 } }, // sale 变
      { branch_number: 'sbc1-002', system_book_code: 'sbc1', branch_num: '002', branch_name: 'B店', metrics: { sale: 3000, delivery: 1000 } }, // 没变
    ];
    const d = diffImport(current, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ branch_num: '001', metric: 'sale', oldValue: 5000, newValue: 5500, diff: 500 });
  });

  it('新增门店（当前无）也算变更', () => {
    const incoming = [
      { branch_number: 'sbc1-001', system_book_code: 'sbc1', branch_num: '001', branch_name: 'A店', metrics: { sale: 5000, delivery: 2000 } },
      { branch_number: 'sbc1-003', system_book_code: 'sbc1', branch_num: '003', branch_name: 'C店', metrics: { sale: 8000, delivery: 0 } },
    ];
    const d = diffImport(current, incoming);
    expect(d.find(x => x.branch_num === '003' && x.metric === 'sale')).toMatchObject({ oldValue: 0, newValue: 8000 });
  });

  it('空 incoming 返回空数组', () => {
    expect(diffImport(current, [])).toEqual([]);
  });

  it('共享 branch_num 但不同 system_book_code 视为不同门店（不互相 diff）', () => {
    // 当前：sbc1(熊喵) branch_num=048 sale=1000
    // 导入：sbc2(品品甜) branch_num=048 sale=9999 —— 这是另一家店，不应被当作对 sbc1-048 的修改
    const cur = [
      { branch_number: '3120-048', system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1000, delivery: 0 } },
    ];
    const incoming = [
      { branch_number: '64188-048', system_book_code: '64188', branch_num: '048', branch_name: '品品甜48号', metrics: { sale: 9999, delivery: 0 } },
    ];
    const d = diffImport(cur, incoming);
    // 应当视为新增门店（cur 端无 64188-048），sale oldValue=0 newValue=9999
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ branch_num: '048', oldValue: 0, newValue: 9999, branch_name: '品品甜48号' });
  });

  it('同 branch_num 同 system_book_code（仅 branch_number 缺失回退）正确对齐', () => {
    // 回退路径：无 branch_number 时按 system_book_code-branch_num 匹配
    const cur = [
      { system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1000, delivery: 0 } },
    ];
    const incoming = [
      { system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1500, delivery: 0 } },
    ];
    const d = diffImport(cur, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ oldValue: 1000, newValue: 1500 });
  });

  it('branch_number 与 system_book_code-branch_num 复合键交叉不匹配', () => {
    // cur 用 branch_number 标识，inc 仅 system_book_code-branch_num（无 branch_number）—— 同一店应能匹配
    const cur = [
      { branch_number: '3120-048', system_book_code: '3120', branch_num: '048', metrics: { sale: 1000, delivery: 0 } },
    ];
    const incoming = [
      { system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1500, delivery: 0 } },
    ];
    const d = diffImport(cur, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ oldValue: 1000, newValue: 1500 });
  });

  it('两店共享 branch_num 不同 sbc —— 同时导入两家都不应误匹配对方', () => {
    // cur 同时持有两家共享 048 的店
    const cur = [
      { branch_number: '3120-048', system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1000, delivery: 0 } },
      { branch_number: '64188-048', system_book_code: '64188', branch_num: '048', branch_name: '品品甜48号', metrics: { sale: 2000, delivery: 0 } },
    ];
    // incoming 只更新其中一家（3120 那家），另一家不变
    const incoming = [
      { branch_number: '3120-048', system_book_code: '3120', branch_num: '048', branch_name: '熊喵48号', metrics: { sale: 1111, delivery: 0 } },
    ];
    const d = diffImport(cur, incoming);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ oldValue: 1000, newValue: 1111 });
  });
});
