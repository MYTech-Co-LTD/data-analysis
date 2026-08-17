// functions/wecom-oidc-callback/claims.test.js
// 断言库零依赖（Deno/node 双跑）：手写 assert。
// 运行：cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)
// 模块形态说明：InsForge 运行时为 CommonJS（function.json runtime=commonjs，禁 ESM import/export——
//   index.js 头注），claims.js 因此是 CJS module.exports；本测试同款 require 消费
//   （plan 原文为 ESM import——本机无 deno 且加 package.json type:module 会破坏 CJS 运行时/esbuild 打包，
//   断言本体 10 条逐字保留）。ctx 契约用 expandResult（调用方已 await——plan claims.js/index.js 同款；
//   plan 测试原文的 expand:async 注入与其自身 claims.js 读 ctx.expandResult 不一致，按实现契约为准）。
const { buildClaims } = require('./claims.js');

const eq = (a, b, msg) => { const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { console.error(`✗ ${msg}\n  got:  ${ja}\n  want: ${jb}`);
    if (typeof Deno !== 'undefined') Deno.exit(1); else process.exit(1); }
  else console.log(`✓ ${msg}`); };

// 三段全成功的上下文（expandResult = Task 9 展开的已 await 结果）
const okCtx = {
  oidcToken: { groups: ['shanhai/熊喵-东区', 'shanhai/熊喵-东区-3120-001'] },  // 原生 token groups（F4）
  reachable: ['data-analysis:view:reports', 'push:broadcast', 'data-analysis:field:cost', 'data-analysis:brand:3120'],
  expandResult: { branch_nums: ['3120-001'], ok: true },                       // Task 9 展开注入（已 await）
  catalogV: '20260816.1',
  legacy: { role_code: 'store_manager', visible_panels: ['reports'], default_landing: '/reports', default_metric: 'sale', departments: ['东区'] },
};

// 三段失败注入
const failCtx = { ...okCtx, expandResult: { branch_nums: [], ok: false, error: 'unknown group' } };

eq(buildClaims(okCtx).data_scope.branch_nums, ['3120-001'], '门店叶子展开进 data_scope.branch_nums');
eq(buildClaims(okCtx).groups, ['shanhai/熊喵-东区', 'shanhai/熊喵-东区-3120-001'], 'groups = 原生 token 全路径精确数组');
eq(buildClaims(okCtx).permissions.includes('data-analysis:view:reports'), true, 'permissions = 资源串（B2，非四维 key）');
eq(buildClaims(okCtx).permissions.includes('push:broadcast'), true, 'push 裸 key 保留（H4 禁前缀）');
eq(buildClaims(okCtx).fields.cost, true, 'field:cost 资源 → fields.cost=true');
eq(buildClaims(okCtx).catalog_v, '20260816.1', 'catalog_v 版本戳透传');
eq(buildClaims(okCtx).role_code, 'store_manager', '08-15 保留字段不丢（H5）');

const denied = buildClaims(failCtx);
eq(denied, null, '三段任一失败（展开 ok:false）→ 返回 null = 登录整体失败，禁空数组进 claims（C2）');

// B6 终态（W6 / Task 20）：顶层旧四维 key 镜像摘除——授权有值也不再写（双氧期结束）
const c = buildClaims(okCtx);
eq(c.branch_nums, undefined, '顶层旧 key branch_nums 不存在（有授权也不镜像——镜像已摘，B6 终态）');
eq(c.brands, undefined, '顶层旧 key brands 不存在');
eq(c.categories, undefined, '顶层旧 key categories 不存在');
eq(c.can_see_cost, undefined, '顶层旧 key can_see_cost 不存在（fields.cost=true 也不再镜像）');
eq(c.fields.cost, true, '新段 fields.cost 仍是唯一判定源（终版 can_cost_visible 只读此段）');

// 空集形态（B1 deny 载体）与摘除后旧 key 缺位的一致性
const zeroScopeCtx = { ...okCtx, expandResult: { branch_nums: [], ok: true }, reachable: [] };
const z = buildClaims(zeroScopeCtx);
eq(z.data_scope.branch_nums, [], '空集段 = authorized ∅（deny 语义载体，B1）');
eq(z.branch_nums, undefined, '顶层旧 key 无授权时同样不存在（不存在「空数组镜像」形态）');

console.log('claims.test.js: all assertions passed');

// ============ 全店→'*' 收敛（2026-08-17 胖 cookie 修复）============
// 背景见 index.js 头注：388 店清单把 JWT 撑到 8120B，超浏览器 cookie 4096B 上限被静默丢弃 → 登录存不住。
// 收敛规则：expand 结果覆盖 maps 门店全集 → branch_nums=['*']（scope_match_v2 通配=放行，语义=全店）。
const { collapseFullStore } = require('./claims.js');

eq(collapseFullStore(['3120-001', '3120-002'], ['3120-001', '3120-002']), ['*'], '全店覆盖（乱序同集）→ ["*"]');
eq(collapseFullStore(['3120-002', '3120-001'], ['3120-001', '3120-002']), ['*'], '全店覆盖（顺序无关）→ ["*"]');
eq(collapseFullStore(['3120-001'], ['3120-001', '3120-002']), ['3120-001'], '部分覆盖 → 明细列表（不外溢）');
eq(collapseFullStore(['3120-001', '3120-999'], ['3120-001']), ['3120-001', '3120-999'], '结果超集于宇宙 → 仍 ["*"] 形态不取（明细保真，脏数据不放大）');
eq(collapseFullStore([], ['3120-001']), [], '空结果不收敛（B1 空集=deny 语义载体，禁 ["*"]）');
eq(collapseFullStore(['3120-001'], []), ['3120-001'], '宇宙空（maps 无门店行）→ 明细透传');
eq(collapseFullStore(undefined, ['3120-001']), [], 'undefined 入参 → 空数组（防御，不抛）');

console.log('collapseFullStore assertions passed');

// ============ resolveGroupBranches（企微部门组形态 + 旧门店组过渡兼容，2026-08-17 组树迁移）============
// 新形态：maps 行 group_id=部门名 × branch_number 多行（部门→门店集，职能部门=全店 388 行）。
// 旧形态回退：门店组前缀展开（迁移窗口内 5 管理员旧挂组仍工作）。
// 组存在但 maps 无行（未灌映射的新部门）→ unknown fail-close（C2，禁半可达）。
const { resolveGroupBranches } = require('./claims.js');
const R = (o) => JSON.stringify(o);

eq(R(resolveGroupBranches(['shanhai/东部一区'], [
  { group_id: '东部一区', branch_number: '3120-0001' },
  { group_id: '东部一区', branch_number: '3120-0002' },
  { group_id: '东部二区', branch_number: '3120-0003' },
])), R({ branch_nums: ['3120-0001', '3120-0002'], ok: true }), '部门组多行映射全命中（全路径剥前缀，他组行不外溢）');

eq(R(resolveGroupBranches(['shanhai/熊喵-3120-0001'], [
  { group_id: '熊喵-3120-0001', group_type: 'store', branch_number: '3120-0001' },
])), R({ branch_nums: ['3120-0001'], ok: true }), '旧门店组精确行兼容（迁移窗口）');

eq(R(resolveGroupBranches(['shanhai/熊喵'], [
  { group_id: '熊喵-3120-0001', group_type: 'store', branch_number: '3120-0001' },
  { group_id: '熊喵-3120-0002', group_type: 'store', branch_number: '3120-0002' },
])), R({ branch_nums: ['3120-0001', '3120-0002'], ok: true }), '旧区域根前缀回退兼容（迁移窗口）');

eq(R(resolveGroupBranches(['shanhai/新部门'], [])),
  R({ branch_nums: [], ok: false, error: 'unknown group: 新部门' }), '组无映射行 → fail-close（禁半可达）');

eq(R(resolveGroupBranches(['shanhai/南部五区'], [], new Set(['南部五区']))),
  R({ branch_nums: [], ok: true }), '合法空辖区（org_departments 有 maps 无行）→ 贡献空集不 fail-close');

eq(R(resolveGroupBranches(['shanhai/南部五区', 'shanhai/东部一区'], [
  { group_id: '东部一区', branch_number: '3120-0002' },
], new Set(['南部五区']))),
  R({ branch_nums: ['3120-0002'], ok: true }), '空辖区与有映射组混合 → 空集不拖垮整体（LiuHeFa 形态）');

eq(R(resolveGroupBranches(['shanhai/真未知组'], [], new Set(['南部五区']))),
  R({ branch_nums: [], ok: false, error: 'unknown group: 真未知组' }), 'knownDepts 不含的组仍 fail-close（保守方向不变）');

eq(R(resolveGroupBranches(['shanhai/东部一区', 'shanhai/总经办'], [
  { group_id: '总经办', branch_number: '3120-0001' },
  { group_id: '东部一区', branch_number: '3120-0002' },
])), R({ branch_nums: ['3120-0001', '3120-0002'], ok: true }), '多组并集（兼职多挂）');

console.log('resolveGroupBranches assertions passed');

// ============ 方案甲：通俗名 → 能力 key 归一（2026-08-17，Casdoor resource.name=通俗名）============
// 管理员在 Casdoor 下拉框选中通俗名（如「指标概览」）→ 写进 permission.resources 的是通俗名 →
// claims B2 过滤前必须还原成 key，否则通俗名被 startsWith('data-analysis:') 丢弃 → 权限静默丢失。
const { normalizeFriendlyPerm } = require('./claims.js');

// 1. 13 个看板/KPI 通俗名全部映射到正确 key（与 capability-board.ts 单真相同步）
const friendly = {
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
for (const [f, key] of Object.entries(friendly)) {
  eq(normalizeFriendlyPerm(f), key, `通俗名归一：${f} → ${key}`);
}

// 2. 未命中的值原样返回（key / 通配 / push 裸 key / 未知串都不动）
eq(normalizeFriendlyPerm('data-analysis:view-board:*'), 'data-analysis:view-board:*', '通配原样透传');
eq(normalizeFriendlyPerm('push:broadcast'), 'push:broadcast', 'push 裸 key 原样透传');
eq(normalizeFriendlyPerm('data-analysis:view:reports'), 'data-analysis:view:reports', '完整 key 原样透传');
eq(normalizeFriendlyPerm('未知通俗名'), '未知通俗名', '未知串原样透传（不误伤）');

// 3. buildClaims 集成：reachable 里含通俗名 → permissions 里还原成 key（B2 过滤前归一）
const friendlyCtx = {
  ...okCtx,
  reachable: ['data-analysis:view:reports', '指标概览', '门店零售', 'push:broadcast'],
};
const fc = buildClaims(friendlyCtx);
eq(fc.permissions.includes('data-analysis:view-board:kpi'), true, '通俗名「指标概览」归一回 key 进 permissions');
eq(fc.permissions.includes('data-analysis:view-kpi:sale'), true, '通俗名「门店零售」归一回 key 进 permissions');
eq(fc.permissions.includes('指标概览'), false, '通俗名本身不进 permissions（已归一）');

console.log('方案甲 通俗名归一 assertions passed');
