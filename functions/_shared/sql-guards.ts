// functions/_shared/sql-guards.ts
// 复合键 join 守卫（机械强制）——问数网关 validateSql 的共享纯逻辑，零依赖。
//
// ① 门店键铁律：任何 ON/USING 里出现 branch_num 必须同时带 system_book_code。
//    （branch_num 跨 lemeng 账套重复：3120/64188 各自从 1 编号，128 个编号两账套撞号不同店；
//      2026-08-20 三次实测裸 branch_num 跨品牌扇出错标后置入 agent-query/index.js，
//      现提取到此处与商品键规则共存并供单测锁定。）
//
// ② 商品键铁律（2026-08-27 小海单品报表全量×2 事故后新增）：JOIN dim_item 必须携带商品键——
//    item_num 同样是账套内编号（非全局唯一），必须配 system_book_code 复合成键；
//    或用跨账套全局唯一的货来源编码（明细侧 pos_item_code ↔ dim_item.item_code）单独作键。
//    裸 item_name 一律拒绝：dim_item 是双账套表，12,209 个商品名中 6,056 个在两账套同名不同货，
//    按名 join 让每条明细命中 2 行维表 → 整表精确 ×2（毛利 9,736.11 → 19,472.22 分毫实证）。
//    单独匹配品牌也不放行（同品牌内一对多扇出到所有商品行）。
//
// 报错约定（网关把 e.message 放进 {"error":"sql_rejected","rule":...} 返回）：
//   forbidden_branch_join / forbidden_item_join
const ALIAS_RE = "(?:\\s+(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?";
// JOIN 目标表名 + 可选别名 + ON 子句体（截到下一个关键字边界）
const JOIN_ON_RE = new RegExp(
  "\\bJOIN\\s+([A-Za-z_][A-Za-z0-9_]*)" + ALIAS_RE + "\\s+ON\\b([\\s\\S]*?)(?=\\b(?:JOIN|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING|UNION)\\b|$)",
  "gi",
);
const JOIN_USING_RE = new RegExp(
  "\\bJOIN\\s+([A-Za-z_][A-Za-z0-9_]*)" + ALIAS_RE + "\\s+USING\\s*\\(([^)]*)\\)",
  "gi",
);

type JoinVisitor = (table: string, clauseKind: "on" | "using", onText: string) => void;

function forEachJoinClause(sql: string, visit: JoinVisitor): void {
  let m: RegExpExecArray | null;
  JOIN_ON_RE.lastIndex = 0;
  while ((m = JOIN_ON_RE.exec(sql)) !== null) visit(m[1], "on", m[2] || "");
  JOIN_USING_RE.lastIndex = 0;
  while ((m = JOIN_USING_RE.exec(sql)) !== null) visit(m[1], "using", m[2] || "");
}

// ① 门店键：对每条 JOIN 子句（不限目标表）生效——历史上对所有表统一执行，保持语义不变。
export function assertBranchJoin(sql: string): void {
  forEachJoinClause(sql, (_table, _kind, onText) => {
    if (/\bbranch_num\b/i.test(onText) && !/\bsystem_book_code\b/i.test(onText)) {
      throw new Error("forbidden_branch_join");
    }
  });
}

const HAS_ITEM_KEY_RE = /\b(?:item_num|item_code|pos_item_code)\b/i;

// ② 商品键：仅当 JOIN 目标是 dim_item 时生效。
//    通过条件 = 商品键存在 且（brand 锚存在 或 item_code 单独作键）。
export function assertItemJoin(sql: string): void {
  forEachJoinClause(sql, (table, _kind, onText) => {
    if (!new RegExp("^dim_item$", "i").test(table)) return;
    const hasKey = HAS_ITEM_KEY_RE.test(onText);
    const keyIsGloballyUnique = /\bitem_code\b/i.test(onText);
    const hasBrandAnchor = /\bsystem_book_code\b/i.test(onText);
    if (!hasKey || !(keyIsGloballyUnique || hasBrandAnchor)) {
      throw new Error("forbidden_item_join");
    }
  });
}

// 组合入口（agent-query/index.js validateSql 接线点）：先门店后商品，报错顺序确定。
export function assertCompositeKeyJoins(sql: string): void {
  assertBranchJoin(sql);
  assertItemJoin(sql);
}
