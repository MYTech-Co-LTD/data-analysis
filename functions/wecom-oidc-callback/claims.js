// functions/wecom-oidc-callback/claims.js
// claims 构建器（spec §5.4，W3 变更集）——三段：原生 token groups / get-all-objects 可达对象 / 门店叶子展开。
// 模块形态：InsForge 运行时为 CommonJS（function.json runtime=commonjs），index.js require 消费，
//   由 esbuild --bundle --format=cjs 内联进部署单文件（与 _shared 同款机制）。
// 铁律：
//  B2  permissions = data-analysis:* 资源串 + push:* 裸 key（引擎字面量，H4 禁 data-analysis: 前缀）；
//      迁移前旧值是四维维度 key（branch_nums/brands/categories/can_see_cost）——本函数不再产出。
//  B1  data_scope 空段 = authorized ∅（deny）——原样写空数组，禁收敛 ["*"]。
//      data_scope 三维恒存在（无授权=空数组，不是缺段）——brands 缺段会令品牌粒度表 legacy 回退放宽（S4）。
//  B6/M1 顶层旧四维 key 只在「有非空镜像值」时写；禁空数组/省略形态漂进 072 的空数组→true 全放路径。
//       （判定不读顶层旧 key——RLS 策略分支以 data_scope 段存在性为准，迁移 179；旧 key 仅兼容展示/审计。）
//  C2  三段任一失败（展开 ok:false / groups 段缺失 / 可达对象拉取失败）→ 返回 null = 登录整体失败。
//  H5  08-15 保留字段（role_code/visible_panels/default_landing/default_metric/departments）全量透传。
function buildClaims(ctx) {
  // --- 三段输入完整性（C2 fail-close）---
  const oidcGroups = ctx.oidcToken?.groups ?? null;
  if (!Array.isArray(oidcGroups) || oidcGroups.length === 0) return null;   // 半可达/无组 → 整体失败
  if (!Array.isArray(ctx.reachable)) return null;                            // get-all-objects 失败 → 整体失败
  const expanded = ctx.expandResult;                                         // 已由调用方 await（index.js 组装）
  if (!expanded || expanded.ok !== true) return null;                        // 展开失败/未知组 → 整体失败

  // --- permissions（B2）：资源串过滤 ---
  const permissions = ctx.reachable.filter((k) =>
    k === '*' || k.startsWith('data-analysis:') || k.startsWith('push:'));

  // --- data_scope（B1）三维 ---
  const brands     = permissions.filter((k) => k.startsWith('data-analysis:brand:')).map((k) => k.slice('data-analysis:brand:'.length));
  const categories = permissions.filter((k) => k.startsWith('data-analysis:category:')).map((k) => k.slice('data-analysis:category:'.length));
  const data_scope = { brands, categories, branch_nums: [...(expanded.branch_nums ?? [])] };

  // --- fields（列掩码开关）---
  const fields = { cost: permissions.includes('data-analysis:field:cost') };

  // --- 顶层旧 key 全维非空镜像（B6/M1 值判据：只在非空时写）---
  const mirror = {};
  if (data_scope.branch_nums.length) mirror.branch_nums = data_scope.branch_nums;
  if (brands.length)                 mirror.brands = brands;
  if (categories.length)             mirror.categories = categories;
  if (fields.cost)                   mirror.can_see_cost = true;

  return {
    ...ctx.legacy,                       // H5：08-15 保留字段（role_code 等）全量透传
    permissions,                         // B2 资源串
    groups: oidcGroups,                  // F4：原生 token 全路径（判定用，禁中文 label 派生）
    data_scope,                          // B1：空段 = deny 语义载体
    fields,
    catalog_v: ctx.catalogV,
    ...mirror,                           // B6：双氧期顶层旧 key（全维非空镜像，禁空数组）
  };
}

module.exports = { buildClaims };
