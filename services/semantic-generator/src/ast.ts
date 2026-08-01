/**
 * AST 表达式 + 递归翻译器（反自由发挥核心）
 *
 * metric_registry.formula 存 AST（JSONB），生成器用 astToSql 递归翻译成 SQL。
 * 翻译器是纯 switch（无解析/无正则/无模式匹配）--AI 无分支可塞口径。
 * 口径变更 = 改 registry 的 AST 数据，不改本文件。
 *
 * resolveRef 是唯一「认 metric_code」的点：metric_code->cteN.code；窗口列->tgt.col；未知->throw。
 */

export type Ast =
  | { t: 'ref'; code: string }
  | { t: 'lit'; v: number | string }
  | { t: 'op'; op: '+' | '-' | '/' | '*'; l: Ast; r: Ast }
  | { t: 'call'; fn: string; args: Ast[] }
  | { t: 'filter'; expr: Ast; col: string; val: Ast };

/** 窗口列（非 metric_code，来自 tgt CTE）：口径无关的固定集合 */
export const WINDOW_COLS = new Set(['total_days', 'days_elapsed', 'latest_day', 'current_date']);

export interface AstCtx {
  /** metric_code -> CTE 别名（如 'sale_amount' -> 'cte0'）。base/daily/target 列都在各自 CTE */
  cteOf: Map<string, string>;
  /** true: 窗口列前缀 tgt.（target_window 开）；false: 裸标识符 */
  useTargetWindow: boolean;
  /** derived metric_code -> 其 AST（derived 引用 derived 时递归展开，如 delivery_sale_ratio 引用 distribution_amount） */
  derivedAst?: (code: string) => Ast | undefined;
  /** true: base ref 包 COALESCE(cte.code, 0) 防 NULL 传播（additive 多源如 3120+64188，一侧 NULL 致整体 NULL） */
  coalesceRefs?: boolean;
}

/** 解析 ref：已知 metric -> cteN.code（可选 COALESCE）；窗口列 -> tgt.col；derived ref -> 递归展开；未知 -> throw */
export function resolveRef(code: string, ctx: AstCtx): string {
  const cte = ctx.cteOf.get(code);
  if (cte) {
    // 窗口列（total_days/days_elapsed）即使注册到 cteOf 也不 COALESCE（非 NULL，避免改 greatest/nullif 表达式）
    const wrap = ctx.coalesceRefs && !WINDOW_COLS.has(code);
    return wrap ? `COALESCE(${cte}.${code}, 0)` : `${cte}.${code}`;
  }
  if (WINDOW_COLS.has(code)) return ctx.useTargetWindow ? `tgt.${code}` : code;
  if (ctx.derivedAst) {
    const ast = ctx.derivedAst(code);
    if (ast) return `(${astToSql(ast, ctx)})`;  // derived 引用 derived -> 递归展开
  }
  throw new Error(`astToSql: ref '${code}' 既非已知 metric CTE 也非窗口列（${[...WINDOW_COLS].join('/')}）--formula 声明错误或 cteOf 未注册`);
}

/** AST -> SQL 片段（递归翻译，无解析逻辑） */
export function astToSql(node: Ast, ctx: AstCtx): string {
  switch (node.t) {
    case 'ref':
      return resolveRef(node.code, ctx);
    case 'lit':
      return String(node.v);
    case 'op':
      return `(${astToSql(node.l, ctx)} ${node.op} ${astToSql(node.r, ctx)})`;
    case 'call':
      return `${node.fn}(${node.args.map(a => astToSql(a, ctx)).join(', ')})`;
    case 'filter':
      return `${astToSql(node.expr, ctx)} FILTER (WHERE ${node.col} = ${astToSql(node.val, ctx)})`;
  }
}

/** AST -> 人读串（admin UI / 排查用，非生成器输入） */
export function renderFormula(node: Ast): string {
  switch (node.t) {
    case 'ref':
      return node.code;
    case 'lit':
      return String(node.v);
    case 'op':
      return `(${renderFormula(node.l)} ${node.op} ${renderFormula(node.r)})`;
    case 'call':
      return `${node.fn}(${node.args.map(renderFormula).join(', ')})`;
    case 'filter':
      return `${renderFormula(node.expr)} FILTER(${node.col}=${renderFormula(node.val)})`;
  }
}

/** 工具：构造 AST 节点的便捷函数（registry 迁移/测试用） */
export const A = {
  ref: (code: string): Ast => ({ t: 'ref', code }),
  lit: (v: number | string): Ast => ({ t: 'lit', v }),
  op: (op: '+' | '-' | '/' | '*', l: Ast, r: Ast): Ast => ({ t: 'op', op, l, r }),
  call: (fn: string, ...args: Ast[]): Ast => ({ t: 'call', fn, args }),
  filter: (expr: Ast, col: string, val: Ast): Ast => ({ t: 'filter', expr, col, val }),
};

/**
 * AST 结构分类（非字符串正则，基于 AST 节点结构判断，稳）
 * - filter -> daily（CTE 内产 FILTER 列，SELECT 引用）
 * - op '/' 且分母是 call greatest/nullif -> remaining（round 2）
 * - op '/' 其它 -> rate（round 4）
 * - 其它（op +/-/*）-> additive（COALESCE 0）
 */
export type DerivedKind = 'daily' | 'rate' | 'remaining' | 'additive';
export function classifyAst(ast: Ast): DerivedKind {
  if (ast.t === 'filter') return 'daily';
  if (ast.t === 'op' && ast.op === '/') {
    if (ast.r.t === 'call' && (ast.r.fn === 'greatest' || ast.r.fn === 'nullif')) return 'remaining';
    return 'rate';
  }
  return 'additive';
}

/**
 * derived 指标 SELECT 表达式（口径来自 AST，格式包装在此--口径/格式分离）。
 *   rate -> round(core, 4)；remaining -> round(core, 2)；additive/daily -> COALESCE(core, 0)
 * 不含 cost 脱敏（生成器外层 maskCost）、不含 alias（生成器加 AS）。
 * daily 通常不走这里（CTE 内产 FILTER 列，SELECT 引用列名）；若调用则 COALESCE 引用。
 */
export function derivedExpr(ast: Ast, ctx: AstCtx): string {
  const kind = classifyAst(ast);
  // rate：分母 NULLIF 防除零（AST 里分母是裸 ref，无 NULLIF）
  if (kind === 'rate' && ast.t === 'op') {
    const num = astToSql(ast.l, ctx);
    const den = astToSql(ast.r, ctx);
    return `round((${num} / NULLIF(${den}, 0)), 4)`;
  }
  const core = astToSql(ast, ctx);
  switch (kind) {
    case 'remaining': return `round(${core}, 2)`;
    case 'daily': return `COALESCE(${core}, 0)`;
    default: return `COALESCE(${core}, 0)`;  // additive
  }
}
