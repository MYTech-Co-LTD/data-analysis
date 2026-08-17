#!/usr/bin/env node
// scripts/migrate-resource-display-prefix.mjs —— Casdoor resource.name 加「组|」前缀迁移（2026-08-17）
// 目标：34 个 resource.name + 5 个 role-* permission.resources 从「裸通俗名/映射名」改为「组|label」。
// ⚠ 生产 fork 的 update-resource/get-resource 定位不到裸名存储（getResource 强制加 / 前缀）→
//    resource 表必须 DB 直改（opsh casdoor-postgres）；permission 走 update-permission API（可用）。
// 用法（--live 才真写入，默认 dry-run 打印 plan）：
//   node scripts/migrate-resource-display-prefix.mjs [--live]
// env：CASDOOR_API_URL / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / CASDOOR_ORG（deploy/.env 注入）；
//   SSH：本脚本不直连 DB——DB 直改用 ssh opsh docker exec 命令（见文档），脚本只处理 permission API 侧。
import { pathToFileURL } from 'node:url';

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

// 展示名静态镜像（与 web/lib/capability-catalog.ts 同步；脚本间不 import 防耦合——静态镜像，claims.js 同源）
// 23 条：catalog 具名 10 + 看板 7 + KPI 6。
export const DISPLAY_NAME_MAP = new Map([
  ['data-analysis:view:reports', '看板|经营总览'],
  ['data-analysis:view:reports-targets', '看板|目标达成'],
  ['data-analysis:view-group:reports-all', '看板|报表看板全组'],
  ['data-analysis:brand:3120', '品牌|熊喵鲜生'],
  ['data-analysis:brand:64188', '品牌|品品甜'],
  ['data-analysis:category:水果', '品类|水果'],
  ['data-analysis:category:标品', '品类|标品'],
  ['data-analysis:category:耗材', '品类|耗材'],
  ['data-analysis:field:cost', '字段|成本可见'],
  ['data-analysis:admin', '门禁|管理台'],
  // 看板层 7
  ['data-analysis:view-board:kpi', '看板|指标概览'],
  ['data-analysis:view-board:brand', '看板|品牌×指标'],
  ['data-analysis:view-board:region', '看板|门店战区'],
  ['data-analysis:view-board:item-top', '看板|商品 TOP'],
  ['data-analysis:view-board:category', '看板|类别出库'],
  ['data-analysis:view-board:supply-chain', '看板|供应链出库'],
  ['data-analysis:view-board:wholesale', '看板|外部批发'],
  // KPI 卡层 6
  ['data-analysis:view-kpi:sale', '看板|门店零售'],
  ['data-analysis:view-kpi:delivery', '看板|门店配送'],
  ['data-analysis:view-kpi:outbound_amt', '看板|供应链出库金额'],
  ['data-analysis:view-kpi:outbound_profit', '看板|供应链毛利'],
  ['data-analysis:view-kpi:delivery_sale_ratio', '看板|总配销比'],
  ['data-analysis:view-kpi:outbound_margin', '看板|毛利率'],
]);

export function buildResourceNameMap() {
  return new Map(DISPLAY_NAME_MAP);
}

// permission.resources 迁移：旧裸 key/裸通俗名 → 组|label；通配/引擎裸 key/未知名原样
export function migrateResources(map, resources) {
  const out = [];
  for (const r of resources) {
    const key = map.get(r) ?? r;                     // 裸 key 直接命中
    const friendly = [...map.values()].find((v) => v.endsWith(`|${r}`)) ?? r;  // 旧裸通俗名 → 组|label
    const next = map.has(r) ? key : friendly;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

// ---- client_credentials（migrate-perms-friendly 同款） ----
async function getAccessToken() {
  const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: process.env.CASDOOR_CLIENT_ID || '',
      client_secret: process.env.CASDOOR_CLIENT_SECRET || '', scope: 'openid',
    }),
  });
  if (!resp.ok) throw new Error(`token fetch failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('token response missing access_token');
  return data.access_token;
}

async function fetchPermissions(token) {
  const resp = await fetch(`${CASDOOR_API}/api/get-permissions?owner=${encodeURIComponent(CASDOOR_ORG)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`get-permissions failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const j = await resp.json().catch(() => null);
  return Array.isArray(j) ? j : (j?.data ?? []);
}

// update-permission：带完整字段（防 .AllCols().Update() 清空未传字段）
async function updatePermission(token, perm) {
  const resp = await fetch(`${CASDOOR_API}/api/update-permission?id=${encodeURIComponent(perm.owner + '/' + perm.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      owner: perm.owner,
      name: perm.name,
      displayName: perm.displayName ?? '',
      description: perm.description ?? '',
      users: perm.users ?? [],
      groups: perm.groups ?? [],
      roles: perm.roles ?? [],
      domains: perm.domains ?? [],
      resources: perm.resources ?? [],
      actions: perm.actions ?? [],
      effect: perm.effect ?? 'Allow',
      isEnabled: perm.isEnabled ?? true,
    }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || (body && body.status === 'error')) {
    throw new Error(`update-permission ${perm.owner}/${perm.name} failed: ${resp.status} ${body?.msg ?? await resp.text().catch(() => '')}`);
  }
  return body;
}

async function main() {
  const live = process.argv.includes('--live');
  const map = buildResourceNameMap();
  const token = await getAccessToken();
  const perms = await fetchPermissions(token);
  const targets = perms.filter((p) => String(p.name || '').startsWith('role-'));

  const changed = [];
  for (const p of targets) {
    const before = (p.resources ?? []).map((r) => String(r));
    const after = migrateResources(map, before);
    const isChanged = JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort());
    console.log(`\n[permission] ${p.name}${isChanged ? ' ★ 需迁移' : ' ✓ 无需变更'}`);
    if (isChanged) {
      console.log('  before:', JSON.stringify(before, null, 0));
      console.log('  after: ', JSON.stringify(after, null, 0));
      changed.push({ name: p.name, after });
    }
  }

  console.log(`\n[summary] role-* permission ${targets.length}：变更 ${changed.length}`);
  console.log(`\n[resource] DB 直改提示：ssh opsh 内 casdoor-postgres 执行\n  UPDATE resource SET name = <组|label> WHERE description = <key>;\n  （34 个，脚本只负责 permission API 侧；DB 直改命令见实施文档）`);

  if (live) {
    console.log('\n[--live] 开始写入 permission...');
    for (const e of changed) {
      const target = targets.find((t) => t.name === e.name);
      const res = await updatePermission(token, { ...target, resources: e.after });
      console.log(`  ✓ ${e.name}: update-permission ${res?.status ?? 'ok'}`);
    }
    console.log('\n完成。随后执行 DB 直改命令迁移 resource 表，再跑 reconcile 验证。');
  } else {
    console.log('\n[dry-run] 未写 Casdoor。确认后加 --live 执行。');
  }
}

const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  main().catch((e) => { console.error('[migrate-resource-display-prefix] Fatal:', e.message); process.exit(2); });
}
