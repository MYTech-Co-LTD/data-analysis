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
}

/** 解析 ref：已知 metric -> cteN.code；窗口列 -> tgt.col 或裸标识符；未知 -> throw（防引用不存在的 metric） */
export function resolveRef(code: string, ctx: AstCtx): string {
  const cte = ctx.cteOf.get(code);
  if (cte) return `${cte}.${code}`;
  if (WINDOW_COLS.has(code)) return ctx.useTargetWindow ? `tgt.${code}` : code;
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
