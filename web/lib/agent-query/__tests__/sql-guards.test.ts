// agent-query 网关 SQL 守卫单测（functions/_shared/sql-guards.ts 的镜像契约）
// 背景：2026-08-27 小海单品报表全量×2 事故——bot 生成的 SQL 用裸 item_name join dim_item
// （dim_item 双账套，12,209 商品名中 6,056 个在 3120/64188 同名不同货）→ 整表扇出 ×2。
// 存量门店复合键守卫（branch_num 必配 system_book_code）从 agent-query/index.js 提取至共享模块，
// 与新增商品键守卫一起在此锁定回归。
import { describe, it, expect } from "vitest";
import {
  assertBranchJoin,
  assertItemJoin,
  assertCompositeKeyJoins,
} from "../../../../functions/_shared/sql-guards";

const pass = (fn: (sql: string) => void, sql: string) =>
  it(`通过: ${sql.slice(0, 60)}…`, () => expect(() => fn(sql)).not.toThrow());

describe("assertBranchJoin（存量门店复合键规则，提取后不得回归）", () => {
  it("裸 branch_num join 拒绝 forbidden_branch_join", () => {
    expect(() =>
      assertBranchJoin(
        "SELECT * FROM retail_detail r LEFT JOIN dim_branch db ON r.branch_num=db.branch_num"
      )
    ).toThrowError(/forbidden_branch_join/);
  });
  pass(
    assertBranchJoin,
    "LEFT JOIN dim_branch db ON r.system_book_code=db.system_book_code AND r.branch_num=db.branch_num"
  );
  it("USING 裸 branch_num 同样拒绝", () => {
    expect(() =>
      assertBranchJoin("LEFT JOIN dim_branch b USING (branch_num)")
    ).toThrowError(/forbidden_branch_join/);
  });
});

describe("assertItemJoin：dim_item 复合键守卫（小海单品翻倍事故回归）", () => {
  const BUG =
    "SELECT di.item_name, SUM(o.amount) amt FROM outbound_detail o " +
    "LEFT JOIN dim_item di ON o.item_name=di.item_name " +
    "WHERE o.biz_date='2026-08-26' GROUP BY 1";

  it("事故复现：裸 item_name join 拒绝 forbidden_item_join", () => {
    expect(() => assertItemJoin(BUG)).toThrowError(/forbidden_item_join/);
  });
  it("品牌+裸名仍拒绝（同品牌内同名不同货照样扇出）", () => {
    expect(() =>
      assertItemJoin(
        "JOIN dim_item di ON o.sbc=di.system_book_code AND o.item_name=di.item_name"
      )
    ).toThrowError(/forbidden_item_join/);
  });
  it("仅品牌、无商品键拒绝（一对多到所有商品行）", () => {
    expect(() =>
      assertItemJoin("JOIN DIM_ITEM DI ON DI.SYSTEM_BOOK_CODE = O.SBC")
    ).toThrowError(/forbidden_item_join/);
  });
  it("大写表名同样受控", () => {
    expect(() =>
      assertItemJoin("LEFT JOIN DIM_ITEM DI ON O.ITEM_NAME=DI.ITEM_NAME")
    ).toThrowError(/forbidden_item_join/);
  });
  pass(
    assertItemJoin,
    "LEFT JOIN dim_item di ON o.sbc=di.system_book_code AND o.item_num=di.item_num"
  );
  it("全局唯一编码可单独作键（无品牌锚也放行）", () => {
    expect(() =>
      assertItemJoin("JOIN dim_item di ON o.pos_item_code=di.item_code")
    ).not.toThrow();
  });
  it("USING 裸 item_name 拒绝；USING 复合通过", () => {
    expect(() =>
      assertItemJoin("LEFT JOIN dim_item di USING (item_name)")
    ).toThrowError(/forbidden_item_join/);
    expect(() =>
      assertItemJoin("LEFT JOIN dim_item di USING (system_book_code, item_num)")
    ).not.toThrow();
  });
  it("与 dim_item 无关的 join 不受影响（item 词出现也不误伤）", () => {
    expect(() =>
      assertItemJoin("LEFT JOIN dim_branch db ON db.branch_num=r.branch_num")
    ).not.toThrow();
  });
  it("非 JOIN 的 dim_item 引用（WHERE 过滤维表自身）不受限", () => {
    expect(() =>
      assertItemJoin("SELECT * FROM dim_item WHERE system_book_code='3120'")
    ).not.toThrow();
  });
});

describe("assertCompositeKeyJoins 组合入口（index.js 接线点）", () => {
  it("两条规则同时生效：先门店后商品（报错顺序确定）", () => {
    expect(() =>
      assertCompositeKeyJoins(
        "FROM retail_detail r LEFT JOIN dim_branch db ON r.branch_num=db.branch_num " +
          "LEFT JOIN dim_item di ON o.item_name=di.item_name"
      )
    ).toThrowError(/forbidden_branch_join/);
  });
});
