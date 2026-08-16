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

// B6/M1 值判据：顶层旧 key = 全维非空镜像（brands 有值时镜像；branch_nums 无授权时——不存在「空数组镜像」）
const zeroScopeCtx = { ...okCtx, expandResult: { branch_nums: [], ok: true }, reachable: [] };
const z = buildClaims(zeroScopeCtx);
eq(z.data_scope.branch_nums, [], '空集段 = authorized ∅（deny 语义载体，B1）');
eq(z.branch_nums, undefined, '顶层旧 key 无非空镜像值时不写（禁空数组——072 空数组→true 全放，M1）');

console.log('claims.test.js: all assertions passed');
