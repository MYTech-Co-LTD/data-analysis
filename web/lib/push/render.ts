/**
 * 推送渲染模块
 *
 * 契约来源：spec §5.2
 * - 为每组生成短时代签 JWT（10min，只读，scope 绑定）
 * - 从语义视图查推送变量值
 * - can_see_cost=false → cost_sensitive 变量脱敏为 '（无权限查看）'
 * - 分页游标变量（如 detail_url）必须含 JWT 代签（非明文 db_user/db_pass）
 */

import crypto from 'crypto';
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
  if (!secret || secret.length < 16) throw new Error('JWT_SECRET not set or too short');

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  // M4/方案 A：代签 JWT 升级为新形状——内嵌 data_scope + fields + departments（与登录 claims 同形状）。
  //   RLS（scope_match_v2）读 data_scope 段放行；旧顶层四维 key 摘除（185 双氧期已结束，无消费方）。
  const payload = {
    role: 'authenticated',
    data_scope: perms.data_scope,
    fields: perms.fields,
    departments: perms.departments ?? [],
    iat: now,
    exp: now + 600, // 10 分钟
  };

  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const h = enc(header);
  const p = enc(payload);

  // HMAC-SHA256 签名
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

    // 成本脱敏（新形状：fields.cost）
    if (isCostSensitive(v) && !perms.fields?.cost) {
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
    // S7/spec-forge：branch_nums 为空 → 该 URL 变量不渲染（防 brand-only 用户收空链接假成功——
    //   JWT data_scope.branch_nums=[] → RLS deny → 报表空白）
    if (!perms.data_scope?.branch_nums?.length) return null;
    // 缺口 2 修复（2026-08-19）：URL 只带 jwt——scope 全在代签 JWT 里（RLS 读 data_scope），
    //   branch/brand/category 参数冗余且会把 URL 撑到 2000+ 字符（分区 69 店 = 843 字符）→ 企微截断。
    //   明细页 /report/detail 直接以 jwt 为 PostgREST Bearer，RLS 裁剪；scope 从 JWT 解码显示。
    //   2026-08-19 二次修复：绝对 URL——相对路径在企微里不可点。PUSH_BRIDGE_BASE_URL 含 /api/wecom-bridge
    //   （bridge 路径），剥离后缀得 app 根（https://data.shanhaiyiguo.com）。
    const view = code.replace('_url', '');
    const base = (process.env.PUSH_BRIDGE_BASE_URL || '').replace(/\/api\/wecom-bridge$/, '');
    return `${base}/report/${view}?jwt=${encodeURIComponent(jwt)}`;
  }

  // 数值型变量 → 从视图聚合查询
  // 这里返回占位符，实际实现在 run_push 编排中注入
  return null;
}
