import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database', 'migrations');

describe('生成器多源视图产出', () => {
  it('distribution_drill SQL 含多源 UNION + 外层合总', () => {
    const f = fs.readdirSync(MIGRATIONS_DIR).find(x => x.endsWith('_generated_distribution_drill.sql'));
    if (!f) { expect(f, 'distribution_drill SQL 文件未生成').toBeDefined(); return; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/combined/); // 外层合总
    expect(sql).toMatch(/report_daily_delivery/);
    expect(sql).toMatch(/report_daily_wholesale/);
    expect(sql).toMatch(/distribution_amount/);
  });

  it('outbound_drill SQL 含外部客户虚拟节点', () => {
    const f = fs.readdirSync(MIGRATIONS_DIR).find(x => x.endsWith('_generated_outbound_drill.sql'));
    if (!f) { expect(f, 'outbound_drill SQL 文件未生成').toBeDefined(); return; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    expect(sql).toMatch(/'外部客户'/);
    expect(sql).toMatch(/wholesale_ext_amount/);
  });
});
