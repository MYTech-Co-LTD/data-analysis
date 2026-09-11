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
  name: string;
  sensitive: boolean;
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

// 门店复合键表达式校验。非法抛错（message = 错误码），调用方据此 fail-close（不建视图 + 不进白名单）。
export function validateScopeKeyExpr(expr: string, columnNames: string[]): void {
  const t = String(expr ?? "").trim();
  if (!t) throw new Error("empty_scope_expr");
  if (t.includes(";")) throw new Error("scope_expr_semicolon");
  const u = t.toUpperCase();
  for (const kw of EXPR_FORBIDDEN_KEYWORDS) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("scope_expr_forbidden_keyword");
  }
  // 必须引用本数据集至少一列（挡纯常量，如 '3120-7'）
  const hit = columnNames.some((c) =>
    new RegExp("\\b" + String(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(t)
  );
  if (!hit) throw new Error("scope_expr_no_column");
}

// 生成权限视图 SQL。caller 负责先跑 validateScopeKeyExpr 与「注册列非空」校验。
export function buildFactViewSql(spec: FactViewSpec): string {
  const cols = spec.columns || [];
  if (cols.length === 0) throw new Error("empty_columns");
  const canSee = spec.canSeeCost ? "TRUE" : "FALSE";
  // ① 列投影：敏感列整组按 can_see_cost 脱敏
  const projection = cols
    .map((c) =>
      c.sensitive
        ? `CASE WHEN ${canSee} THEN ${sqlIdent(c.name)} ELSE NULL END AS ${sqlIdent(c.name)}`
        : sqlIdent(c.name)
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
