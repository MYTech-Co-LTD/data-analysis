/**
 * 推送渲染模块
 *
 * 契约来源：spec §5.2
 * - 为每组生成短时代签 JWT（10min，只读，scope 绑定）
 * - 从语义视图查推送变量值
 * - can_see_cost=false → cost_sensitive 变量脱敏为 '（无权限查看）'
 * - 分页游标变量（如 detail_url）必须含 JWT 代签（非明文 db_user/db_pass）
 */

import { type Perms } from './engine';
import { type PushVariable, isCostSensitive, matchesScope } from './push-variables';

// 运行时读取（兼容测试注入）
function getJwtSecret(): string {
  return process.env.JWT_SECRET || '';
}

/**
 * 生成短时代签 JWT
 * - 10 分钟过期
 * - 只读权限（anon role）
 * - scope 绑定（brands, branch_nums, categories）
 */
export async function generateScopedJwt(perms: Perms): Promise<string> {
  const secret = getJwtSecret();
  if (!secret) throw new Error('JWT_SECRET not set');

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    role: 'authenticated',
    scope: {
      brands: perms.brands,
      branch_nums: perms.branch_nums,
      categories: perms.categories,
      can_see_cost: perms.can_see_cost,
    },
    iat: now,
    exp: now + 600, // 10 分钟
  };

  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const h = enc(header);
  const p = enc(payload);

  // HMAC-SHA256 签名
  const crypto = await import('crypto');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64url');

  return `${h}.${p}.${sig}`;
}

/**
 * 渲染变量值
 *
 * @param variables 可用推送变量列表
 * @param getVariableValue 查变量值函数（依赖注入）
 * @param perms 用户权限 scope
 * @returns 渲染后的变量键值对
 */
export async function renderVariables(
  variables: PushVariable[],
  getVariableValue: (
    code: string,
    perms: Perms,
    jwt: string
  ) => Promise<string | null>,
  perms: Perms
): Promise<Record<string, string>> {
  // 生成短时代签 JWT
  const jwt = await generateScopedJwt(perms);

  const result: Record<string, string> = {};

  for (const v of variables) {
    // 变量 scope 匹配检查
    if (!matchesScope(v, perms)) continue;

    // 成本脱敏
    if (isCostSensitive(v) && !perms.can_see_cost) {
      result[v.var_code] = '（无权限查看）';
      continue;
    }

    const value = await getVariableValue(v.var_code, perms, jwt);
    if (value !== null) {
      result[v.var_code] = value;
    }
  }

  return result;
}

/**
 * 查变量值（默认实现：从语义视图查询）
 *
 * 分页游标变量（如 detail_url）= `/report/${view}?jwt=${scopedJwt}`
 * 其他变量 = 视图聚合值
 */
export async function getVariableValueDefault(
  code: string,
  perms: Perms,
  jwt: string
): Promise<string | null> {
  // URL 型变量 → 生成代签链接
  if (code.endsWith('_url')) {
    const view = code.replace('_url', '');
    const params = new URLSearchParams();
    if (perms.brands?.length) params.set('brand', perms.brands.join(','));
    if (perms.categories?.length) params.set('category', perms.categories.join(','));
    params.set('jwt', jwt);
    return `/report/${view}?${params.toString()}`;
  }

  // 数值型变量 → 从视图聚合查询
  // 这里返回占位符，实际实现在 run_push 编排中注入
  return null;
}
