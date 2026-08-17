// functions/wecom-oidc-callback/claims.js
// claims 构建器（spec §5.4，W3 变更集）——三段：原生 token groups / get-all-objects 可达对象 / 门店叶子展开。
// 模块形态：InsForge 运行时为 CommonJS（function.json runtime=commonjs），index.js require 消费，
//   由 esbuild --bundle --format=cjs 内联进部署单文件（与 _shared 同款机制）。
// 铁律：
//  B2  permissions = data-analysis:* 资源串 + push:* 裸 key（引擎字面量，H4 禁 data-analysis: 前缀）；
//      迁移前旧值是四维维度 key（branch_nums/brands/categories/can_see_cost）——本函数不再产出。
//  B1  data_scope 空段 = authorized ∅（deny）——原样写空数组，禁收敛 ["*"]。
//      data_scope 三维恒存在（无授权=空数组，不是缺段）——brands 缺段会令品牌粒度表 legacy 回退放宽（S4）。
//  B6  顶层旧四维 key 镜像已摘（W6 / Task 20，双氧期结束）：新令牌只携带新四段
//      （permissions/groups/data_scope/fields/catalog_v）+ H5 保留字段；072 legacy 消费面随
//      scope_match_v2 终版（185 摘回退支）一并退役——旧形状令牌 = deny，不再需要镜像兼容。
//  C2  三段任一失败（展开 ok:false / groups 段缺失 / 可达对象拉取失败）→ 返回 null = 登录整体失败。
//  H5  08-15 保留字段（role_code/visible_panels/default_landing/default_metric/departments）全量透传。
// 方案甲（2026-08-17 通俗名归一）：Casdoor resource.name 用通俗名（如「指标概览」），管理员从
//     Casdoor 下拉框选中后写进 permission.resources 的是通俗名——本函数在 B2 过滤前先把通俗名
//     还原成能力 key（FRIENDLY_TO_KEY 内置映射表，与 web/lib/capability-board.ts 单真相同步，
//     由 claims.test.js 断言防漂移；重名已在单真相加载时断言唯一）。
function buildClaims(ctx) {
  // --- 三段输入完整性（C2 fail-close）---
  const oidcGroups = ctx.oidcToken?.groups ?? null;
  if (!Array.isArray(oidcGroups) || oidcGroups.length === 0) return null;   // 半可达/无组 → 整体失败
  if (!Array.isArray(ctx.reachable)) return null;                            // get-all-objects 失败 → 整体失败
  const expanded = ctx.expandResult;                                         // 已由调用方 await（index.js 组装）
  if (!expanded || expanded.ok !== true) return null;                        // 展开失败/未知组 → 整体失败

  // 方案甲：通俗名 → 能力 key 归一（内置映射表见文件底部，与 capability-board.ts 单真相同步）
  const normReach = ctx.reachable.map((k) => FRIENDLY_TO_KEY[k] ?? k);

  // --- permissions（B2）：资源串过滤（去重——get-all-objects 并集路径可能重复，claims 需唯一）---
  const permissions = [...new Set(normReach.filter((k) =>
    k === '*' || k.startsWith('data-analysis:') || k.startsWith('push:')))];

  // --- data_scope（B1）三维 ---
  const brands     = permissions.filter((k) => k.startsWith('data-analysis:brand:')).map((k) => k.slice('data-analysis:brand:'.length));
  const categories = permissions.filter((k) => k.startsWith('data-analysis:category:')).map((k) => k.slice('data-analysis:category:'.length));
  const data_scope = { brands, categories, branch_nums: [...(expanded.branch_nums ?? [])] };

  // --- fields（列掩码开关）---
  const fields = { cost: permissions.includes('data-analysis:field:cost') };

  // B6 终态（W6 / Task 20）：顶层旧四维 key 镜像不再产出（双氧期结束；旧 key 消费面已随
  // scope_match_v2 终版/can_cost_visible 终版统一读新段）。旧令牌自然过期即完成全量切换。
  return {
    ...ctx.legacy,                       // H5：08-15 保留字段（role_code 等）全量透传
    permissions,                         // B2 资源串
    groups: oidcGroups,                  // F4：原生 token 全路径（判定用，禁中文 label 派生）
    data_scope,                          // B1：空段 = deny 语义载体
    fields,
    catalog_v: ctx.catalogV,
  };
}

module.exports = { buildClaims, collapseFullStore, resolveGroupBranches };

// 通俗名 → 能力 key 内置映射（方案甲 2026-08-17）。与 web/lib/capability-board.ts 单真相同步：
// 看板 7（BOARD_CAPABILITIES）+ KPI 卡 6（KPI_CARD_CAPABILITIES）。
// ⚠ 保持同步：新增/改名能力必须同步这里 + capability-board.ts + claims.test.js 断言（防漂移）。
// ⚠ 禁改值语义：key 是 Casdoor permission.resources 的权威授权串，通俗名只是展示层别名。
// ⚠ 重名已在 capability-board.ts 加载时断言唯一（2026-08-17：KPI「供应链出库」→「供应链出库金额」消歧）。
const FRIENDLY_TO_KEY = {
  '指标概览': 'data-analysis:view-board:kpi',
  '品牌×指标': 'data-analysis:view-board:brand',
  '门店战区': 'data-analysis:view-board:region',
  '商品 TOP': 'data-analysis:view-board:item-top',
  '类别出库': 'data-analysis:view-board:category',
  '供应链出库': 'data-analysis:view-board:supply-chain',
  '外部批发': 'data-analysis:view-board:wholesale',
  '门店零售': 'data-analysis:view-kpi:sale',
  '门店配送': 'data-analysis:view-kpi:delivery',
  '供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '毛利率': 'data-analysis:view-kpi:outbound_margin',
};

// 归一函数（供 index.js 或测试直接调用：通俗名 → key，未命中原样返回）
function normalizeFriendlyPerm(value) {
  return FRIENDLY_TO_KEY[value] ?? value;
}

module.exports = { buildClaims, collapseFullStore, resolveGroupBranches, FRIENDLY_TO_KEY, normalizeFriendlyPerm };

// 组→门店集解析（2026-08-17 组树迁移企微部门树，用户裁定「组织架构严格按企微」）：
//   新形态（部门组）：maps 行 group_id=部门名 × branch_number 多行——部门→门店集映射
//   （战区/区部门→辖区门店多行；职能部门→全店 388 行）。任一命中行即贡献，group_type 不再区分。
//   旧形态回退（门店组过渡兼容）：迁移窗口内旧挂组（熊喵/品品甜根、熊喵-3120-xxxx 门店组）经
//   store 前缀展开继续工作——两条路径共存直至旧组树删除。
//   组存在但 maps 无行 → 二分：①部门树（org_departments）里存在 = 合法空辖区部门（企微树超前
//   于 dim 数据，如南部五区建区未配店，2026-08-17 生产实况）——贡献空集不阻断；②否则未知组
//   fail-close（C2 禁半可达；部门同步器灌组须同步灌 maps）。
function resolveGroupBranches(groupPaths, maps, knownDepts) {
  const deptSet = knownDepts instanceof Set ? knownDepts : null;
  const results = new Set();
  for (const path of groupPaths ?? []) {
    const g = String(path).split('/').pop();                     // 全路径 'shanhai/部门名' → 组名
    const rows = (maps ?? []).filter((m) => m.group_id === g && m.branch_number);
    if (rows.length > 0) {
      for (const m of rows) results.add(m.branch_number);        // 部门组多行映射
      continue;
    }
    const asRegion = (maps ?? []).some((m) => m.group_type === 'store' && m.group_id.startsWith(g + '-'));
    if (asRegion) {
      for (const m of maps) {
        if (m.group_type === 'store' && m.group_id.startsWith(g + '-') && m.branch_number) results.add(m.branch_number);
      }
      continue;
    }
    if (deptSet && deptSet.has(g)) continue;                     // 合法空辖区（企微树有 dim 无店）——贡献空集
    return { branch_nums: [], ok: false, error: `unknown group: ${g}` };   // fail-close（H13 未知组）
  }
  return { branch_nums: [...results].sort(), ok: true };
}

// 全店→'*' 收敛（2026-08-17 胖 cookie 修复，用户裁定）：expand 结果与 maps 门店全集**集合相等**时
// branch_nums 收敛为 ['*']（scope_match_v2 通配=放行，语义=全店授权，与明细清单访问面完全等价）。
// 动机：388 店清单把 JWT 撑到 8120B，超浏览器 cookie 4096B 上限被静默丢弃 → 登录态存不住（502 修复后
// 扫码仍循环回登录页的根因）。收敛后全店用户 JWT ≈1.2KB。
// 边界：集合相等才收敛（超集/子集都保明细——脏数据不放大）；空结果不收敛（B1 空集=deny 语义载体，
// 禁 ["*"]）；宇宙空（maps 无门店行）→ 明细透传。
function collapseFullStore(branchNums, allStoreNums) {
  const uniq = [...new Set(branchNums ?? [])];
  const universe = new Set(allStoreNums ?? []);
  if (uniq.length === 0 || universe.size === 0) return [...uniq].sort();
  const covered = uniq.every((b) => universe.has(b)) && [...universe].every((b) => uniq.includes(b));
  return covered ? ['*'] : [...uniq].sort();
}
