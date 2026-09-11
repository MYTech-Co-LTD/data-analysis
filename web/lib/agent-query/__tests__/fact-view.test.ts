// 通用事实视图纯函数单测（functions/_shared/fact-view.ts 的镜像契约）
// 背景：spec 2026-09-11-replenishment-detail-query-onboarding-design
// 关键不变量：① 列投影只含注册列（未注册列如单头金额天然消失）
//            ② 行过滤 fail-close（授权空集 → WHERE 1=0，非「不过滤」）
//            ③ 表达式校验挡住常量/多语句（防行过滤失效 → 越权）
import { describe, it, expect } from "vitest";
import {
  validateScopeKeyExpr,
  buildFactViewSql,
  sqlLit,
} from "../../../../functions/_shared/fact-view";

const COLS = ["system_book_code", "branch_num", "branch_name", "subtotal", "total_money"];

describe("sqlLit（共享转义，agent-query 亦复用）", () => {
  it("普通串加引号", () => {
    expect(sqlLit("3120-7")).toBe("'3120-7'");
  });

  it("单引号翻倍（防注入）", () => {
    expect(sqlLit("a'b")).toBe("'a''b'");
  });
});

describe("validateScopeKeyExpr", () => {
  it("合法表达式通过", () => {
    expect(() =>
      validateScopeKeyExpr(
        "regexp_replace(system_book_code || '-' || branch_num, '^([0-9]+)-0+([0-9]+)$', '\\1-\\2')",
        COLS
      )
    ).not.toThrow();
  });

  it("空表达式拒绝 empty_scope_expr", () => {
    expect(() => validateScopeKeyExpr("   ", COLS)).toThrowError(/empty_scope_expr/);
  });

  it("多语句拒绝 scope_expr_semicolon", () => {
    expect(() => validateScopeKeyExpr("system_book_code; DROP TABLE x", COLS)).toThrowError(
      /scope_expr_semicolon/
    );
  });

  it("子查询拒绝 scope_expr_forbidden_keyword", () => {
    expect(() =>
      validateScopeKeyExpr("(SELECT 'x' FROM t) || branch_num", COLS)
    ).toThrowError(/scope_expr_forbidden_keyword/);
  });

  it("不引用本数据集任何列 → scope_expr_no_column（挡纯常量）", () => {
    expect(() => validateScopeKeyExpr("'3120-7'", COLS)).toThrowError(/scope_expr_no_column/);
  });

  // ★ 常量折叠绕过（2026-09-11 评审实证）：列名只出现在字符串字面量里 → 必须同样拒绝，
  //   否则 WHERE <常量> IN ('3120-7') 恒真 = 行过滤失效 = 越权。
  it("列名只在字面量里 → 仍拒绝（防常量折叠越权）", () => {
    expect(() => validateScopeKeyExpr("'branch_num' || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    expect(() => validateScopeKeyExpr("left('branch_num', 0) || '3120-7'", COLS)).toThrowError(
      /scope_expr_no_column/
    );
    expect(() =>
      validateScopeKeyExpr("regexp_replace('branch_num', '.*', '3120-7')", COLS)
    ).toThrowError(/scope_expr_no_column/);
  });

  it("字面量里含禁词不误拒（关键字扫描同样先剥字面量）", () => {
    expect(() =>
      validateScopeKeyExpr("regexp_replace(branch_name, 'delete', '')", COLS)
    ).not.toThrow();
  });

  it("引用列名但大小写不同视为合法（SQL 标识符不区分大小写）", () => {
    expect(() => validateScopeKeyExpr("SYSTEM_BOOK_CODE || '-' || branch_num", COLS)).not.toThrow();
  });
});

describe("buildFactViewSql：列投影 = 注册列", () => {
  const base = {
    name: "replenishment_detail",
    glob: "s3://lemeng-datasource/duckle/lemeng/replenishment_detail/*/*/all.parquet",
    scopeKeyExpr: "system_book_code || '-' || branch_num",
    canSeeCost: false,
  };

  it("未注册的列不出现在视图里（total_money 消失）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [
        { name: "system_book_code", sensitive: false },
        { name: "branch_num", sensitive: false },
        { name: "subtotal", sensitive: false },
      ],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('"subtotal"');
    expect(sql).not.toContain("total_money");
  });

  it("敏感列套 CASE WHEN 脱敏", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "profit", sensitive: true }],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('CASE WHEN FALSE THEN "profit" ELSE NULL END AS "profit"');
  });

  it("canSeeCost=true 时脱敏开关放开", () => {
    const sql = buildFactViewSql({
      ...base,
      canSeeCost: true,
      columns: [{ name: "profit", sensitive: true }],
      authKeys: ["3120-7"],
      allBranches: false,
    });
    expect(sql).toContain('CASE WHEN TRUE THEN "profit" ELSE NULL END AS "profit"');
  });

  it("授权空集 → WHERE 1=0（fail-close，不是不过滤）", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: false,
    });
    expect(sql).toContain("WHERE 1=0");
    expect(sql).not.toContain("IN (");
  });

  it("全量授权 → 不加行过滤", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: true,
    });
    expect(sql).not.toContain("WHERE");
  });

  it("窄授权 → IN 列表 + 单引号转义 + WHERE 用 scopeKeyExpr 本尊", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: ["3120-7", "3120-8"],
      allBranches: false,
    });
    expect(sql).toContain(`IN ('3120-7', '3120-8')`);
    // ★ 钉住核心契约：WHERE 左值必须是传入的 scopeKeyExpr 本尊——
    //   否则「丢掉表达式、只留 IN 列表」的实现能通过其余全部用例（行过滤实质失效）。
    expect(sql).toContain(`WHERE ${base.scopeKeyExpr} IN ('3120-7', '3120-8')`);
  });

  it("始终读 parquet 全列（union_by_name）并按名字取注册列", () => {
    const sql = buildFactViewSql({
      ...base,
      columns: [{ name: "branch_num", sensitive: false }],
      authKeys: [],
      allBranches: true,
    });
    expect(sql).toContain(`read_parquet('${base.glob}', union_by_name=true)`);
    expect(sql).toMatch(/CREATE OR REPLACE TEMP VIEW replenishment_detail AS/);
  });

  it("注册列名为空 → 拒绝 empty_columns", () => {
    expect(() =>
      buildFactViewSql({ ...base, columns: [], authKeys: ["3120-7"], allBranches: false })
    ).toThrowError(/empty_columns/);
  });
});
