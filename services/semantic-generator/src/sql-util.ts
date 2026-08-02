// SQL 片段生成小工具（生成器共享）

/** target_status 配置（string | string[]）→ SQL IN 子句。默认 ['active']。 */
export function statusInClause(status: string | string[] | undefined, column = 'status'): string {
  const list = Array.isArray(status) ? status : [status ?? 'active'];
  return `${column} IN (${list.map(s => `'${s}'`).join(', ')})`;
}
