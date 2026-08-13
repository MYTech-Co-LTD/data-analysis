// web/lib/permission-guards.ts
// 权限管理写路径输入校验（安全终检 F4/F6）：
//  - F6：数组维（branch_nums/brands/categories）只接受纯字符串数组；
//        非数组/含非字符串 → 路由 400，杜绝畸形 JSONB 落库（get_user_perms 已加 jsonb_typeof 兜底，写路径再拒绝）。
//  - F4：空数组 == 未配（等价 null）。写入前规范化，避免落「配了空数组」的语义噪音，
//        「全 null 删行恢复继承」判定也基于规范化后的值。
export type NormArr =
  | { status: 'missing' } // undefined：字段未在 body 出现（保留旧值语义，见 roles/depts 合并）
  | { status: 'null' }    // null 或空数组
  | { status: 'ok'; value: string[] }
  | { status: 'bad' };    // 非数组 / 含非字符串

export function normArr(v: unknown): NormArr {
  if (v === undefined) return { status: 'missing' };
  if (v === null) return { status: 'null' };
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return { status: 'bad' };
  return (v as string[]).length ? { status: 'ok', value: v as string[] } : { status: 'null' };
}

// 规范化结果 → 落库值（null = 未配）。与「该维未出现（保留旧值）」区分使用。
export function arrOrNull(n?: NormArr): string[] | null {
  return n && n.status === 'ok' ? n.value : null;
}

// can_see_cost / expires_at 基本类型校验（写路径拒绝类型混淆）
export function canSeeCostOk(v: unknown): boolean {
  return v === undefined || v === null || typeof v === 'boolean';
}
export function expiresAtOk(v: unknown): boolean {
  return v === undefined || v === null || typeof v === 'string';
}