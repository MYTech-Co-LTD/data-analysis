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

// ============ 方案甲/方案 C：通俗名 → 能力 key 归一（2026-08-17，Casdoor resource.name=通俗名）============
// 管理员在 Casdoor 下拉框选中通俗名（如「指标概览」）→ 写进 permission.resources 的是通俗名 →
// claims B2 过滤前必须还原成 key，否则通俗名被 startsWith('data-analysis:') 丢弃 → 权限静默丢失。
const { normalizeFriendlyPerm, FRIENDLY_TO_KEY, BOARD_VIEW_COVERAGE } = require('./claims.js');

// 1. 23 个通俗名全部映射到正确 key（与 capability-catalog.ts + capability-board.ts 单真相同步）
const friendly = {
  // catalog 具名 10（页面级 + 品牌/品类/字段/管理台/组）
  '看板|经营总览': 'data-analysis:view:reports',
  '看板|目标达成': 'data-analysis:view:reports-targets',
  '品牌|熊喵鲜生': 'data-analysis:brand:3120',
  '品牌|品品甜': 'data-analysis:brand:64188',
  '品类|水果': 'data-analysis:category:水果',
  '品类|标品': 'data-analysis:category:标品',
  '品类|耗材': 'data-analysis:category:耗材',
  '字段|成本可见': 'data-analysis:field:cost',
  '门禁|管理台': 'data-analysis:admin',
  '门禁|报表中心': 'data-analysis:gate:reports-center',
  // 看板层 7（BOARD_CAPABILITIES）
  '看板|指标概览': 'data-analysis:view-board:kpi',
  '看板|品牌×指标': 'data-analysis:view-board:brand',
  '看板|门店战区': 'data-analysis:view-board:region',
  '看板|商品 TOP': 'data-analysis:view-board:item-top',
  '看板|类别出库': 'data-analysis:view-board:category',
  '看板|供应链出库': 'data-analysis:view-board:supply-chain',
  '看板|外部批发': 'data-analysis:view-board:wholesale',
  // KPI 卡层 6（KPI_CARD_CAPABILITIES）
  '看板|门店零售': 'data-analysis:view-kpi:sale',
  '看板|门店配送': 'data-analysis:view-kpi:delivery',
  '看板|供应链出库金额': 'data-analysis:view-kpi:outbound_amt',
  '看板|供应链毛利': 'data-analysis:view-kpi:outbound_profit',
  '看板|总配销比': 'data-analysis:view-kpi:delivery_sale_ratio',
  '看板|毛利率': 'data-analysis:view-kpi:outbound_margin',
};
for (const [f, key] of Object.entries(friendly)) {
  eq(normalizeFriendlyPerm(f), key, `通俗名归一：${f} → ${key}`);
}
// 23 条映射全部断言过（防漏同步）
eq(Object.keys(FRIENDLY_TO_KEY).length, 23, 'FRIENDLY_TO_KEY 恰 23 条（10 catalog + 7 看板 + 6 KPI）');

// 2. 未命中的值原样返回（key / 通配 / push 裸 key / 未知串都不动）
eq(normalizeFriendlyPerm('data-analysis:view-board:*'), 'data-analysis:view-board:*', '通配原样透传');
eq(normalizeFriendlyPerm('push:broadcast'), 'push:broadcast', 'push 裸 key 原样透传');
eq(normalizeFriendlyPerm('data-analysis:view:reports'), 'data-analysis:view:reports', '完整 key 原样透传');
eq(normalizeFriendlyPerm('未知通俗名'), '未知通俗名', '未知串原样透传（不误伤）');

// 3. buildClaims 集成：reachable 里含通俗名 → permissions 里还原成 key（B2 过滤前归一）
const friendlyCtx = {
  ...okCtx,
  reachable: ['data-analysis:view:reports', '看板|指标概览', '看板|门店零售', 'push:broadcast'],
};
const fc = buildClaims(friendlyCtx);
eq(fc.permissions.includes('data-analysis:view-board:kpi'), true, '展示名「看板|指标概览」归一回 key 进 permissions');
eq(fc.permissions.includes('data-analysis:view-kpi:sale'), true, '展示名「看板|门店零售」归一回 key 进 permissions');
eq(fc.permissions.includes('看板|指标概览'), false, '展示名本身不进 permissions（已归一）');

// 4. 方案 C 覆盖视图注入：reachable 含看板能力 → permissions 含覆盖的报表视图 key（报表授权 ⇒ 视图访问）
const coverageCtx = {
  ...okCtx,
  reachable: ['data-analysis:view-board:brand', 'data-analysis:view-board:wholesale', 'push:broadcast'],
};
const cc = buildClaims(coverageCtx);
eq(cc.permissions.includes('data-analysis:view-board:brand'), true, '看板能力自身保留');
eq(cc.permissions.includes('data-analysis:view:report_brand_metric_gen'), true, '品牌看板覆盖注入报表视图 key');
eq(cc.permissions.includes('data-analysis:view:report_wholesale_customer_gen'), true, '批发看板覆盖注入（客户明细）');
eq(cc.permissions.includes('data-analysis:view:report_wholesale_daily_gen'), true, '批发看板覆盖注入（日报）');
eq(cc.permissions.includes('data-analysis:view:report_wholesale_daily_customer_gen'), true, '批发看板覆盖注入（客户日榜）');

// 4b. 覆盖注入幂等（看板 key + 已含覆盖 view key → permissions 去重后各 1 个）
const idemCtx = {
  ...okCtx,
  reachable: ['data-analysis:view-board:brand', 'data-analysis:view:report_brand_metric_gen'],
};
const ic = buildClaims(idemCtx);
eq(ic.permissions.filter((k) => k === 'data-analysis:view:report_brand_metric_gen').length, 1, '覆盖注入幂等：同 view key 不重复');

// 4c. 门禁通俗名「报表中心」→ 组 key 归一（2026-08-18 门禁拆分：旧「报表看板全组」退役进 DEPRECATED）
const groupCtx = {
  ...okCtx,
  reachable: ['门禁|报表中心', 'push:broadcast'],
};
const gc = buildClaims(groupCtx);
eq(gc.permissions.includes('data-analysis:gate:reports-center'), true, '门禁通俗名归一回 gate key 进 permissions');
eq(gc.permissions.includes('门禁|报表中心'), false, '门禁通俗名本身不进 permissions');
eq(gc.permissions.includes('data-analysis:view:reports'), false, 'claims 不展开 view-group（web 侧 buildPermPool 展开）');

// 4d. 覆盖镜像与单真相同步：BOARD_VIEW_COVERAGE 恰 6 个看板有覆盖（kpi 无）
eq(Object.keys(BOARD_VIEW_COVERAGE).length, 6, 'BOARD_VIEW_COVERAGE 恰 6 条（kpi 看板无覆盖报表视图）');

console.log('方案甲/方案C 通俗名归一 + 覆盖注入 assertions passed');

// ════════ 2026-08-18 门店范围显式授权（范围|X 前缀归一 + resolveScopeKeys）════════
const { resolveScopeKeys } = require('./claims.js');

// 5a. 前缀归一：范围|X → data-analysis:branch:X（X 原样透传，不进静态表）
eq(normalizeFriendlyPerm('范围|中部一区'), 'data-analysis:branch:中部一区', '范围前缀归一：包名');
eq(normalizeFriendlyPerm('范围|*'), 'data-analysis:branch:*', '范围前缀归一：通配');
eq(normalizeFriendlyPerm('范围|3120-0006'), 'data-analysis:branch:3120-0006', '范围前缀归一：branch_number');
eq(normalizeFriendlyPerm('范围|武汉光谷店'), 'data-analysis:branch:武汉光谷店', '范围前缀归一：门店中文名');
eq(normalizeFriendlyPerm('品牌|熊喵鲜生'), 'data-analysis:brand:3120', '非范围资源仍走静态表');
eq(normalizeFriendlyPerm('看板|指标概览'), 'data-analysis:view-board:kpi', '非范围资源静态表不受影响');

// 5b. resolveScopeKeys：包名 → 包内门店并集
const mapsFixture = [
  { group_id: '中部一区', group_type: 'dept', branch_number: '3120-0006' },
  { group_id: '中部一区', group_type: 'dept', branch_number: '3120-0010' },
  { group_id: '中部三区', group_type: 'dept', branch_number: '3120-0082' },
];
const dimFixture = [
  { branch_number: '3120-0006', branch_name: '武汉光谷店' },
  { branch_number: '3120-0010', branch_name: '常德武陵店' },
  { branch_number: '3120-0082', branch_name: '长沙岳麓店' },
];
const pk = resolveScopeKeys(['中部一区', '中部三区'], mapsFixture, dimFixture);
eq(pk.ok, true, 'resolveScopeKeys 包名解析 ok');
eq(JSON.stringify(pk.branch_nums), JSON.stringify(['3120-0010', '3120-0082', '3120-0006'].sort()), '两包门店并集');

// 5c. 通配短路 + 单店（编号 / 中文名唯一命中）
eq(JSON.stringify(resolveScopeKeys(['*'], mapsFixture, dimFixture).branch_nums), JSON.stringify(['*']), '通配返回 ["*"]');
eq(resolveScopeKeys(['全店'], mapsFixture, dimFixture).branch_nums[0], '*', '中文别名「全店」=通配');
eq(resolveScopeKeys(['3120-0006'], mapsFixture, dimFixture).branch_nums[0], '3120-0006', 'branch_number 直映');
eq(resolveScopeKeys(['武汉光谷店'], mapsFixture, dimFixture).branch_nums[0], '3120-0006', '门店中文名唯一命中');

// 5d. fail-close：未知键 / 中文名重名
eq(resolveScopeKeys(['不存在的包'], mapsFixture, dimFixture).ok, false, '未知包名 fail-close');
const dupDim = [...dimFixture, { branch_number: '64188-0001', branch_name: '武汉光谷店' }];
eq(resolveScopeKeys(['武汉光谷店'], mapsFixture, dupDim).ok, false, '门店中文名重名 fail-close');

// 5e. buildClaims 集成：范围资源进 permissions，branch 来源仍由 expandResult 注入（index.js 双读选路）
const scopeCtx = {
  ...okCtx,
  reachable: ['范围|中部一区', '品牌|熊喵鲜生'],
};
const sc = buildClaims(scopeCtx);
eq(sc.permissions.includes('data-analysis:branch:中部一区'), true, '范围资源 key 进 permissions');
eq(sc.data_scope.brands, ['3120'], '品牌资源照常解析');
// 注：branch_nums 展开值由 index.js 双读侧（expandScopeResources）注入 expandResult——claims 层不重复展开

console.log('门店范围显式授权 assertions passed');
