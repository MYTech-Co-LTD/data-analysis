// functions/_shared/fact-view.ts
// 通用事实视图的纯逻辑（spec 2026-09-11-replenishment-detail-query-onboarding-design §方案1）
// 零依赖，供 functions/agent-query/index.js require，并在 web/lib/agent-query/__tests__/fact-view.test.ts 锁定契约。
//
// 职责边界：只做「表达式合法性」与「视图 SQL 拼接」两件事，不碰网络/权限数据获取。
// 三条不变量（改动前先读单测）：
//   ① 列投影 = dataset_columns 注册列（显式投影，不用 SELECT *）→ 未注册列天然不可见
//   ② 行过滤 fail-close：授权空集 → WHERE 1=0
//   ③ 表达式必须引用本数据集至少一列 → 挡住纯常量（行过滤失效即越权）

export interface FactColumn {
  name: string; // 视图里的列名（平台口径名）
  sensitive: boolean;
  sourceName?: string; // parquet 里的源列名；为空表示与 name 同名。例：name='system_book_code', sourceName='company_id'
}

export interface FactViewSpec {
  name: string;
  glob: string;
  scopeKeyExpr: string;
  columns: FactColumn[];
  authKeys: string[];
  allBranches: boolean;
  canSeeCost: boolean;
}

// SQL 字符串字面量转义（单引号翻倍）。导出供 agent-query/index.js 复用，避免两份实现漂移。
export function sqlLit(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function sqlIdent(s: string): string {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

// 表达式里出现即视为危险的关键字（子查询/写操作）；只做词边界匹配，不解析 SQL
const EXPR_FORBIDDEN_KEYWORDS = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
  "ATTACH", "DETACH", "COPY", "PRAGMA", "GRANT", "REVOKE", "TRUNCATE", "CALL",
];

// 剥掉 SQL 字符串字面量（单引号，'' 为转义）与行注释，再做关键字/列名扫描。
// ★ 必须先去字面量，否则：
//   ① 列名检查可被常量折叠绕过——`'branch_num' || '3120-7'` 文本里含列名却折叠成常量，
//      `WHERE <常量> IN ('3120-7')` 恒真 → 行过滤失效 → 被授权单店者看见整账套（2026-09-11 评审实证）；
//   ② 关键字检查会误拒 `regexp_replace(branch_name, 'delete', '')` 这类含禁词字面量的合法表达式。
//   fail-close 方向：剥完若不再含任何列名 → scope_expr_no_column 拒绝。
//
// ⚠️ 边界（计划明示，勿继续加固）：这是**尽力而为的剥离，不是 SQL 词法分析器**。SQL 字面量词法有长尾
//   （嵌套注释、更多方言转义形态），继续加固是无底洞且会引入假阳性。权威控制是
//   「scope_key_expr 只能由受审查的迁移写入」+「窄授权冒烟断言」；本校验器只负责让写错的注册值尽快失败。
function stripSqlLiterals(expr: string): string {
  return String(expr)
    .replace(/\/\*[\s\S]*?\*\//g, " ") // 块注释（2026-09-11 复审实证：/* branch_num */ '3120-7' 曾绕过）
    .replace(/--[^\n]*/g, " ") // 行注释
    // DuckDB 方言字面量：dollar-quoted（$$…$$ / $tag$…$tag$）；组 1 未参与匹配时 \1 匹配空串，故 $$…$$ 亦覆盖
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/E'(?:[^'\\]|\\.|'')*'/gi, "''") // E'…' 反斜杠转义字符串
    .replace(/'(?:[^']|'')*'/g, "''"); // 普通字符串字面量
}

// 门店复合键表达式校验。非法抛错（message = 错误码），调用方据此 fail-close（不建视图 + 不进白名单）。
export function validateScopeKeyExpr(expr: string, columnNames: string[]): void {
  const t = String(expr ?? "").trim();
  if (!t) throw new Error("empty_scope_expr");
  if (t.includes(";")) throw new Error("scope_expr_semicolon"); // 分号在字面量里也无害，但拒绝更安全
  const bare = stripSqlLiterals(t); // ← 关键字/列名扫描一律在剥离字面量后的文本上做
  const u = bare.toUpperCase();
  for (const kw of EXPR_FORBIDDEN_KEYWORDS) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("scope_expr_forbidden_keyword");
  }
  // 必须引用本数据集至少一列（**字面量里的列名不算**，挡常量折叠）
  const hit = columnNames.some((c) =>
    new RegExp("\\b" + String(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(bare)
  );
  if (!hit) throw new Error("scope_expr_no_column");
}

// 生成权限视图 SQL。caller 负责先跑 validateScopeKeyExpr 与「注册列非空」校验。
export function buildFactViewSql(spec: FactViewSpec): string {
  const cols = spec.columns || [];
  if (cols.length === 0) throw new Error("empty_columns");
  const canSee = spec.canSeeCost ? "TRUE" : "FALSE";
  // ① 列投影：敏感列整组按 can_see_cost 脱敏；源列名可与视图列名不同（source_name 映射）
  // 例：name='system_book_code' + sourceName='company_id' → "company_id" AS "system_book_code"
  const srcIdent = (c: FactColumn) => sqlIdent(c.sourceName ?? c.name);
  const projection = cols
    .map((c) =>
      c.sensitive
        ? `CASE WHEN ${canSee} THEN ${srcIdent(c)} ELSE NULL END AS ${sqlIdent(c.name)}`
        : `${srcIdent(c)} AS ${sqlIdent(c.name)}`
    )
    .join(", ");
  // ② 行过滤：全量授权不加过滤；否则 IN 授权复合键；空集 → 1=0（fail-close）
  const where = spec.allBranches
    ? ""
    : spec.authKeys.length === 0
      ? " WHERE 1=0"
      : " WHERE " + spec.scopeKeyExpr + " IN (" + spec.authKeys.map(sqlLit).join(", ") + ")";
  return (
    "\nCREATE OR REPLACE TEMP VIEW " + spec.name + " AS SELECT * FROM (" +
    "SELECT " + projection + " FROM read_parquet(" + sqlLit(spec.glob) + ", union_by_name=true)" +
    ") t" + where + ";"
  );
}
