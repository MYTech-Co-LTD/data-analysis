/**
 * push_variables 注册表 TypeScript 接口
 *
 * 契约来源：spec §5.1 + Task 7 迁移 173_push_variables.sql
 * - 推送变量白名单（唯一来源）
 * - 新可推指标 = INSERT 一行，不改引擎/生成器
 * - 门店键铁律：extra_filter 禁裸 branch_num
 */

export interface PushVariable {
  var_code: string;
  name: string;
  metric_code?: string;
  scope_dim: 'total' | 'brand' | 'war_zone' | 'region' | 'branch';
  extra_filter?: Record<string, unknown>;
  unit?: string;
  enabled: boolean;
  cost_sensitive?: boolean; // 从 metric_registry.cost_sensitive 读取
}

/**
 * 成本/利润类敏感变量判定
 *
 * 优先读 cost_sensitive 字段（metric_registry 单源）
 * fallback：var_code 含 cost/profit → 敏感（兼容无字段的种子数据）
 */
export function isCostSensitive(v: PushVariable): boolean {
  if (v.cost_sensitive !== undefined) return v.cost_sensitive;
  // fallback: 字符串匹配（兼容种子数据）
  const code = v.var_code.toLowerCase();
  return code.includes('cost') || code.includes('profit');
}

/**
 * 权限 scope（新形状：data_scope + fields，来自 get_user_perms 双形/登录 claims 同源）
 */
export interface Perms {
  data_scope: { brands: string[]; categories: string[]; branch_nums: string[] };
  fields: { cost: boolean };
  departments?: string[];
}

/**
 * 变量 scope 匹配用户权限
 *
 * 规则：
 * - total 维 → 总是匹配
 * - brand 维 → 用户 data_scope.brands 含变量 brand 或 brands='*'
 * - branch 维 → 需 exact match 或 '*'（URL 渲染另要求 branch_nums 非空，S7）
 */
export function matchesScope(
  v: PushVariable,
  perms: Perms
): boolean {
  // total 维 → 总是匹配
  if (v.scope_dim === 'total') return true;

  // brand 维 → 用户 brands 含变量 brand 或 brands='*'
  if (v.scope_dim === 'brand') {
    if (!perms.data_scope.brands?.length) return false;
    if (perms.data_scope.brands.includes('*')) return true;
    // 从 extra_filter 取品牌限制
    const filterBrands = v.extra_filter?.system_book_code as string[] | undefined;
    if (!filterBrands?.length) return true; // 无品牌限制 → 全品牌可推
    return filterBrands.some((b) => perms.data_scope.brands!.includes(b));
  }

  // branch 维 → 需 exact match 或 '*'
  if (v.scope_dim === 'branch') {
    if (!perms.data_scope.branch_nums?.length) return false;
    if (perms.data_scope.branch_nums.includes('*')) return true;
    const filterBranches = v.extra_filter?.branch_num as string[] | undefined;
    if (!filterBranches?.length) return true;
    return filterBranches.some((b) => perms.data_scope.branch_nums!.includes(b));
  }

  // war_zone/region → 暂不实现细粒度，放行
  return true;
}

// 运行时从数据库读取（生产环境）
let _cached: PushVariable[] | null = null;

/**
 * 获取启用的推送变量列表
 *
 * 测试环境通过 PUSH_VARIABLES_JSON 环境变量注入
 * 生产环境从 PostgREST 读取
 */
export async function getPushVariables(): Promise<PushVariable[]> {
  if (_cached) return _cached;

  // 测试环境：从环境变量注入
  const jsonStr = process.env.PUSH_VARIABLES_JSON;
  if (jsonStr) {
    try {
      _cached = JSON.parse(jsonStr);
      return _cached!;
    } catch {
      // fallback to default
    }
  }

  // 生产环境：从 PostgREST 读取
  const postgrestUrl = process.env.POSTGREST_URL;
  const postgrestKey = process.env.POSTGREST_ANON_KEY;
  if (postgrestUrl && postgrestKey) {
    try {
      const resp = await fetch(
        `${postgrestUrl}/push_variables?enabled=eq.true&order=var_code`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (resp.ok) {
        _cached = await resp.json();
        return _cached!;
      }
    } catch {
      // fallback to default
    }
  }

  // 默认：只含种子变量
  _cached = [
    {
      var_code: 'sale_amount',
      name: '销售额',
      metric_code: 'sale_amount',
      scope_dim: 'total',
      unit: '元',
      enabled: true,
    },
  ];
  return _cached;
}

/**
 * 重置缓存（测试用）
 */
export function resetCache(): void {
  _cached = null;
}

/**
 * 预设推送变量列表（测试用）
 */
export const pushVariables: PushVariable[] = [
  {
    var_code: 'sale_amount',
    name: '销售额',
    metric_code: 'sale_amount',
    scope_dim: 'total',
    unit: '元',
    enabled: true,
  },
  {
    var_code: 'cost_amount',
    name: '成本额',
    metric_code: 'cost_amount',
    scope_dim: 'total',
    unit: '元',
    enabled: true,
  },
  {
    var_code: 'profit_amount',
    name: '利润额',
    metric_code: 'profit_amount',
    scope_dim: 'total',
    unit: '元',
    enabled: true,
  },
  {
    var_code: 'delivery_amount',
    name: '配送额',
    metric_code: 'delivery_amount',
    scope_dim: 'total',
    unit: '元',
    enabled: true,
  },
];
